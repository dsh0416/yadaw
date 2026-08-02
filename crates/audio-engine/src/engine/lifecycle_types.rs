struct RunningAudioEngine {
    _input_stream: Stream,
    _output_stream: Stream,
    metrics: Arc<RuntimeMetrics>,
    key: AudioEngineKey,
    recorder: RecorderController,
    commands: HeapProd<EngineCommand>,
    retired_mixers: HeapCons<Box<NativeMixerRuntime>>,
    meter_bank: Arc<MeterBank>,
    transport: Arc<TransportShared>,
    input_peaks: Arc<InputPeakBank>,
    round_trip_latency: Arc<RoundTripLatencyMeasurement>,
}

struct OutputMixerControl {
    commands: HeapCons<EngineCommand>,
    mixer: Option<Box<NativeMixerRuntime>>,
    retired_mixers: HeapProd<Box<NativeMixerRuntime>>,
}

struct OutputStreamContext {
    metrics: Arc<RuntimeMetrics>,
    mixer_control: OutputMixerControl,
    round_trip_latency: Arc<RoundTripLatencyMeasurement>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AudioEngineKey {
    backend: String,
    input_device_id: String,
    output_device_id: String,
    requested_buffer_size: u32,
    requested_session_sample_rate: Option<u32>,
}

impl RunningAudioEngine {
    fn matches(&self, key: &AudioEngineKey) -> bool {
        self.key.backend == key.backend
            && self.key.input_device_id == key.input_device_id
            && self.key.output_device_id == key.output_device_id
            && self.key.requested_session_sample_rate == key.requested_session_sample_rate
            && (self.key.requested_buffer_size == key.requested_buffer_size
                || self.metrics.input_buffer_size.load(Ordering::Relaxed)
                    == key.requested_buffer_size
                || self.metrics.output_buffer_size.load(Ordering::Relaxed)
                    == key.requested_buffer_size)
            && !self.metrics.faulted.load(Ordering::Relaxed)
    }

    fn reclaim_retired_mixers(&mut self) -> usize {
        let mut reclaimed = 0;
        while self.retired_mixers.try_pop().is_some() {
            reclaimed += 1;
        }
        reclaimed
    }
}

fn take_pending_mixer(
    owner: &AudioEngine,
    sample_rate: u32,
) -> Result<Option<Box<NativeMixerRuntime>>> {
    let mut pending = owner
        .pending_mixer
        .lock()
        .map_err(|_| audio_error("pending mixer lock", "poisoned"))?;
    if let Some(runtime) = pending.as_ref() {
        AudioEngine::validate_session_sample_rate(sample_rate, runtime.sample_rate)?;
    }
    Ok(pending.take())
}

fn audio_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn invalid_config(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}
