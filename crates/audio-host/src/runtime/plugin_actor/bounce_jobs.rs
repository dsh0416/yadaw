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

#[cfg(test)]
mod tests {
    use super::*;
    use heron_audio_engine::{NativeLatencyPolicy, NativeMixerChannel};
    use heron_dsp_runtime::protocol::{LiveLatencyPolicy, LiveMixerGraph};
    use heron_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};
    use std::time::Duration;

    fn channel(id: &str, kind: &str, hardware_output_channels: Vec<u32>) -> NativeMixerChannel {
        NativeMixerChannel {
            id: id.to_owned(),
            name: id.to_owned(),
            color: "#000000".to_owned(),
            kind: kind.to_owned(),
            system_role: None,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output_index: None,
            output_bus: None,
            record_armed: false,
            input_monitoring: false,
            input_source: None,
            input_channels: Vec::new(),
            application_capture: None,
            hardware_output_channels,
            midi_input_port_id: None,
            midi_input_channel: None,
        }
    }

    fn native_graph() -> NativeMixerGraph {
        NativeMixerGraph {
            generation: 1,
            sample_rate: 48_000,
            project_end_tick: 3_840,
            latency_policy: NativeLatencyPolicy::Normal,
            channels: vec![
                channel("master", "master", Vec::new()),
                channel("output", "output", vec![1, 2]),
            ],
            sends: Vec::new(),
            clips: Vec::new(),
            plugins: Vec::new(),
            midi_clips: Vec::new(),
            tempo_events: vec![TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        }
    }

    fn request(operation_id: &str, end_frame: u64) -> BounceOutputRenderRequest {
        let unique = format!(
            "heron-bounce-job-{operation_id}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        );
        let directory = std::env::temp_dir();
        BounceOutputRenderRequest {
            operation_id: operation_id.to_owned(),
            graph_revision: 1,
            graph: LiveMixerGraph {
                sample_rate: 48_000,
                project_end_tick: 3_840,
                latency_policy: LiveLatencyPolicy::Normal,
                channels: Vec::new(),
                sends: Vec::new(),
                clips: Vec::new(),
                plugins: Vec::new(),
                midi_clips: Vec::new(),
                tempo_events: Vec::new(),
                time_signature_events: Vec::new(),
            },
            output_channel_id: "output".to_owned(),
            start_frame: 0,
            end_frame,
            target_sample_rate: 48_000,
            channel_mode: BounceChannelMode::Stereo,
            include_tail: false,
            encoding: BounceEncoding::WavFloat,
            normalization: BounceNormalization::Off,
            scratch_path: directory
                .join(format!("{unique}.scratch"))
                .to_string_lossy()
                .into_owned(),
            encoded_path: directory
                .join(format!("{unique}.wav"))
                .to_string_lossy()
                .into_owned(),
        }
    }

    fn wait_for_terminal(registry: &BounceJobRegistry, operation_id: &str) -> BounceJobStatus {
        for _ in 0..2_000 {
            let status = registry
                .status(operation_id)
                .expect("read bounce job status");
            if status.state != BounceJobState::Running {
                return status;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        panic!("bounce job did not reach a terminal state");
    }

    #[test]
    fn protocol_settings_map_to_every_native_encoding_mode() {
        assert_eq!(dither(BounceDither::Off), NativeBounceDither::Off);
        assert_eq!(dither(BounceDither::Tpdf), NativeBounceDither::Tpdf);
        assert_eq!(
            encoding(BounceEncoding::WavPcm {
                bits: 24,
                dither: BounceDither::Tpdf,
            }),
            NativeBounceFormat::WavPcm {
                bits: 24,
                dither: NativeBounceDither::Tpdf,
            }
        );
        assert_eq!(
            encoding(BounceEncoding::WavFloat),
            NativeBounceFormat::WavFloat
        );
        assert_eq!(
            encoding(BounceEncoding::Flac {
                bits: 16,
                compression: 8,
                dither: BounceDither::Off,
            }),
            NativeBounceFormat::Flac {
                bits: 16,
                compression: 8,
                dither: NativeBounceDither::Off,
            }
        );
        assert_eq!(
            encoding(BounceEncoding::Mp3Cbr { kbps: 192 }),
            NativeBounceFormat::Mp3Cbr { kbps: 192 }
        );
        assert_eq!(
            encoding(BounceEncoding::Mp3Vbr { quality: 2 }),
            NativeBounceFormat::Mp3Vbr { quality: 2 }
        );
        assert_eq!(
            normalization(BounceNormalization::Off),
            NativeBounceNormalization::Off
        );
        assert_eq!(
            normalization(BounceNormalization::OverloadProtection),
            NativeBounceNormalization::OverloadProtection
        );
        assert_eq!(
            normalization(BounceNormalization::TruePeak { target_dbtp: -1.0 }),
            NativeBounceNormalization::TruePeak { target_dbtp: -1.0 }
        );
    }

    #[test]
    fn registry_completes_a_job_and_reconciles_duplicate_status_requests() {
        let registry = BounceJobRegistry::default();
        let request = request("complete", 512);
        let encoded_path = PathBuf::from(&request.encoded_path);

        let initial = registry
            .start(request.clone(), native_graph())
            .expect("start bounce job");
        assert_eq!(initial.state, BounceJobState::Running);
        let duplicate = registry
            .start(request, native_graph())
            .expect("reconcile duplicate bounce job");
        assert_eq!(duplicate.operation_id, "complete");

        let completed = wait_for_terminal(&registry, "complete");
        assert_eq!(completed.state, BounceJobState::Completed);
        assert_eq!(completed.phase, BounceJobPhase::Encoding);
        assert_eq!(completed.sample_peak, Some(0.0));
        assert_eq!(completed.true_peak, Some(0.0));
        assert_eq!(completed.normalization_gain, Some(1.0));
        assert!(completed.error.is_none());
        assert!(encoded_path.exists());
        std::fs::remove_file(encoded_path).expect("remove encoded bounce fixture");
        assert!(registry.status("missing").is_err());
        assert!(registry.cancel("missing").is_err());
    }

    #[test]
    fn registry_reports_failed_and_cancelled_jobs_and_rejects_parallel_work() {
        let registry = BounceJobRegistry::default();
        let failed_request = request("failed", 0);
        let failed_encoded_path = PathBuf::from(&failed_request.encoded_path);
        registry
            .start(failed_request, native_graph())
            .expect("start invalid bounce job");
        let failed = wait_for_terminal(&registry, "failed");
        assert_eq!(failed.state, BounceJobState::Failed);
        assert!(
            failed
                .error
                .as_deref()
                .is_some_and(|error| error.contains("invalid bounce"))
        );
        assert!(!failed_encoded_path.exists());

        let long_request = request("long", 48_000_000);
        let long_encoded_path = PathBuf::from(&long_request.encoded_path);
        registry
            .start(long_request.clone(), native_graph())
            .expect("start cancellable bounce job");
        let duplicate = registry
            .start(long_request, native_graph())
            .expect("reconcile running bounce job");
        assert_eq!(duplicate.state, BounceJobState::Running);
        assert_eq!(
            registry
                .start(request("parallel", 512), native_graph())
                .expect_err("reject parallel bounce job"),
            "another offline bounce is active"
        );
        registry.cancel("long").expect("cancel bounce job");
        let cancelled = wait_for_terminal(&registry, "long");
        assert_eq!(cancelled.state, BounceJobState::Cancelled);
        assert!(cancelled.error.is_none());
        assert!(!long_encoded_path.exists());
    }
}
