impl AudioEngine {
pub fn start_recording(&self, config: NativeRecordingStartConfig) -> Result<()> {
    let guard = self.running
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("audio engine must be running before recording"))?;
    engine.recorder.start(config)
}

pub fn stop_recording(&self) -> Result<NativeRecordingResult> {
    let guard = self.running
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("audio engine is not running"))?;
    engine.recorder.stop()
}

pub fn recording_waveform_snapshot(
    &self,
    start_frame: i64,
    end_frame: i64,
    max_buckets: u32,
) -> Result<NativeWaveformSnapshot> {
    let guard = self.running
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("audio engine is not running"))?;
    engine
        .recorder
        .waveform_snapshot(start_frame, end_frame, max_buckets)
}
}
