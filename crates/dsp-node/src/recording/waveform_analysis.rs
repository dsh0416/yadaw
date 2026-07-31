use super::*;
use super::{finalize::finalize, waveform::build_waveform_levels, writer_format::recording_error};

pub(super) fn analyze_waveform_path(path: &str) -> Result<NativeAnalyzedWaveform> {
    let mut reader = WaveReader::open(path)
        .map_err(|error| recording_error("failed to open waveform source", error))?;
    let format = reader
        .format()
        .map_err(|error| recording_error("failed to read waveform format", error))?;
    let frame_count = reader
        .frame_length()
        .map_err(|error| recording_error("failed to read waveform length", error))?
        as usize;
    let channels = format.channel_count as usize;
    if channels == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "waveform source has no channels",
        ));
    }
    let mut samples = vec![0.0_f32; frame_count * channels];
    let mut frame_reader = reader
        .audio_frame_reader()
        .map_err(|error| recording_error("failed to open waveform audio", error))?;
    let read_frames = frame_reader
        .read_frames(&mut samples)
        .map_err(|error| recording_error("failed to read waveform audio", error))?
        as usize;
    samples.truncate(read_frames * channels);
    Ok(NativeAnalyzedWaveform {
        sample_rate: format.sample_rate,
        channels: channels as u32,
        frame_count: read_frames.min(i64::MAX as usize) as i64,
        waveform_levels: build_waveform_levels(&samples, channels),
    })
}

pub struct AnalyzeWaveformTask {
    path: String,
}

#[napi]
impl Task for AnalyzeWaveformTask {
    type Output = NativeAnalyzedWaveform;
    type JsValue = NativeAnalyzedWaveform;

    fn compute(&mut self) -> Result<Self::Output> {
        analyze_waveform_path(&self.path)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn analyze_waveform(path: String) -> napi::bindgen_prelude::AsyncTask<AnalyzeWaveformTask> {
    napi::bindgen_prelude::AsyncTask::new(AnalyzeWaveformTask { path })
}

pub struct FinalizeRecordingTask {
    config: NativeFinalizeRecordingConfig,
}

#[napi]
impl Task for FinalizeRecordingTask {
    type Output = NativeFinalizedRecording;
    type JsValue = NativeFinalizedRecording;

    fn compute(&mut self) -> Result<Self::Output> {
        finalize(&self.config)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn finalize_recording(
    config: NativeFinalizeRecordingConfig,
) -> napi::bindgen_prelude::AsyncTask<FinalizeRecordingTask> {
    napi::bindgen_prelude::AsyncTask::new(FinalizeRecordingTask { config })
}
