use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use heron_audio_engine::{
    NativeBounceChannelMode, NativeBounceDither, NativeBounceFormat, NativeBounceNormalization,
    NativeBounceProgress, NativeBounceRequest, NativeMixerGraph, render_bounce_output,
};
use heron_dsp_runtime::protocol::{
    BounceChannelMode, BounceDither, BounceEncoding, BounceJobPhase, BounceJobState,
    BounceJobStatus, BounceNormalization, BounceOutputRenderRequest,
};

struct BounceJob {
    cancel: Arc<AtomicBool>,
    status: Arc<Mutex<BounceJobStatus>>,
}

#[derive(Default)]
pub(in crate::runtime) struct BounceJobRegistry {
    jobs: Mutex<HashMap<String, BounceJob>>,
}

fn dither(value: BounceDither) -> NativeBounceDither {
    match value {
        BounceDither::Off => NativeBounceDither::Off,
        BounceDither::Tpdf => NativeBounceDither::Tpdf,
    }
}

fn encoding(value: BounceEncoding) -> NativeBounceFormat {
    match value {
        BounceEncoding::WavPcm {
            bits,
            dither: value,
        } => NativeBounceFormat::WavPcm {
            bits,
            dither: dither(value),
        },
        BounceEncoding::WavFloat => NativeBounceFormat::WavFloat,
        BounceEncoding::Flac {
            bits,
            compression,
            dither: value,
        } => NativeBounceFormat::Flac {
            bits,
            compression,
            dither: dither(value),
        },
        BounceEncoding::Mp3Cbr { kbps } => NativeBounceFormat::Mp3Cbr { kbps },
        BounceEncoding::Mp3Vbr { quality } => NativeBounceFormat::Mp3Vbr { quality },
    }
}

fn normalization(value: BounceNormalization) -> NativeBounceNormalization {
    match value {
        BounceNormalization::Off => NativeBounceNormalization::Off,
        BounceNormalization::OverloadProtection => NativeBounceNormalization::OverloadProtection,
        BounceNormalization::TruePeak { target_dbtp } => {
            NativeBounceNormalization::TruePeak { target_dbtp }
        }
    }
}

impl BounceJobRegistry {
    pub(super) fn start(
        &self,
        request: BounceOutputRenderRequest,
        graph: NativeMixerGraph,
    ) -> Result<BounceJobStatus, String> {
        let operation_id = request.operation_id.clone();
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "bounce job registry is poisoned".to_owned())?;
        if let Some(job) = jobs.get(&operation_id) {
            return job
                .status
                .lock()
                .map(|status| status.clone())
                .map_err(|_| "bounce job status is poisoned".to_owned());
        }
        jobs.retain(|_, job| {
            job.status
                .lock()
                .map(|status| status.state == BounceJobState::Running)
                .unwrap_or(true)
        });
        if jobs.values().any(|job| {
            job.status
                .lock()
                .map(|status| status.state == BounceJobState::Running)
                .unwrap_or(true)
        }) {
            return Err("another offline bounce is active".to_owned());
        }
        let status = BounceJobStatus {
            operation_id: operation_id.clone(),
            state: BounceJobState::Running,
            phase: BounceJobPhase::Preparing,
            completed_units: 0,
            total_units: 0,
            sample_peak: None,
            true_peak: None,
            normalization_gain: None,
            warnings: Vec::new(),
            error: None,
        };
        let shared_status = Arc::new(Mutex::new(status.clone()));
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(
            operation_id.clone(),
            BounceJob {
                cancel: Arc::clone(&cancel),
                status: Arc::clone(&shared_status),
            },
        );
        drop(jobs);

        let scratch_path = PathBuf::from(&request.scratch_path);
        let encoded_path = PathBuf::from(&request.encoded_path);
        let cleanup_scratch_path = scratch_path.clone();
        let cleanup_encoded_path = encoded_path.clone();
        let worker_operation_id = operation_id.clone();
        let spawn_result = thread::Builder::new()
            .name(format!("heron-bounce-{operation_id}"))
            .spawn(move || {
                let native = NativeBounceRequest {
                    graph,
                    output_channel_id: request.output_channel_id,
                    start_frame: request.start_frame,
                    end_frame: request.end_frame,
                    target_sample_rate: request.target_sample_rate,
                    channel_mode: match request.channel_mode {
                        BounceChannelMode::Stereo => NativeBounceChannelMode::Stereo,
                        BounceChannelMode::Mono => NativeBounceChannelMode::Mono,
                    },
                    include_tail: request.include_tail,
                    format: encoding(request.encoding),
                    normalization: normalization(request.normalization),
                    scratch_path: scratch_path.clone(),
                    encoded_path: encoded_path.clone(),
                };
                let result = render_bounce_output(native, &cancel, |progress| {
                    if let Ok(mut status) = shared_status.lock() {
                        match progress {
                            NativeBounceProgress::Preparing => {
                                status.phase = BounceJobPhase::Preparing;
                                status.completed_units = 0;
                                status.total_units = 0;
                            }
                            NativeBounceProgress::Rendering {
                                completed_frames,
                                total_frames,
                            } => {
                                status.phase = BounceJobPhase::Rendering;
                                status.completed_units = completed_frames;
                                status.total_units = total_frames;
                            }
                            NativeBounceProgress::Analyzing => {
                                status.phase = BounceJobPhase::Analyzing;
                                status.completed_units = 0;
                                status.total_units = 0;
                            }
                            NativeBounceProgress::Encoding {
                                completed_frames,
                                total_frames,
                            } => {
                                status.phase = BounceJobPhase::Encoding;
                                status.completed_units = completed_frames;
                                status.total_units = total_frames;
                            }
                        }
                    }
                });
                let _ = std::fs::remove_file(&scratch_path);
                if let Ok(mut status) = shared_status.lock() {
                    match result {
                        Ok(result) => {
                            status.state = BounceJobState::Completed;
                            status.sample_peak = Some(result.sample_peak);
                            status.true_peak = Some(result.true_peak);
                            status.normalization_gain = Some(result.normalization_gain);
                            if result.tail_truncated {
                                status.warnings.push("tail-truncated".to_owned());
                            }
                        }
                        Err(error) => {
                            let cancelled = cancel.load(Ordering::Relaxed);
                            status.state = if cancelled {
                                BounceJobState::Cancelled
                            } else {
                                BounceJobState::Failed
                            };
                            status.error = (!cancelled).then(|| error.to_string());
                            let _ = std::fs::remove_file(&encoded_path);
                        }
                    }
                }
            });
        if let Err(error) = spawn_result {
            if let Ok(mut jobs) = self.jobs.lock() {
                jobs.remove(&worker_operation_id);
            }
            let _ = std::fs::remove_file(cleanup_scratch_path);
            let _ = std::fs::remove_file(cleanup_encoded_path);
            return Err(format!("could not start bounce worker: {error}"));
        }
        Ok(status)
    }

    pub(super) fn status(&self, operation_id: &str) -> Result<BounceJobStatus, String> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| "bounce job registry is poisoned".to_owned())?;
        let job = jobs
            .get(operation_id)
            .ok_or_else(|| "bounce operation was not found".to_owned())?;
        job.status
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "bounce job status is poisoned".to_owned())
    }

    pub(super) fn cancel(&self, operation_id: &str) -> Result<BounceJobStatus, String> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| "bounce job registry is poisoned".to_owned())?;
        let job = jobs
            .get(operation_id)
            .ok_or_else(|| "bounce operation was not found".to_owned())?;
        job.cancel.store(true, Ordering::Release);
        job.status
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "bounce job status is poisoned".to_owned())
    }
}
