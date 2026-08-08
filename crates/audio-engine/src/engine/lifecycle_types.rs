use super::{
    Arc, AudioEngine, AuditionPlayback, Consumer, EngineCommand, Error, HeapCons, HeapProd,
    InputPeakBank, MeterBank, NativeMixerRuntime, Ordering, RecorderController, RecordingTap,
    Result, RoundTripLatencyMeasurement, RuntimeMetrics, Status, Stream, TransportShared,
};

pub(super) struct RunningAudioEngine {
    pub(super) _input_stream: Stream,
    pub(super) _output_stream: Stream,
    pub(super) metrics: Arc<RuntimeMetrics>,
    pub(super) key: AudioEngineKey,
    pub(super) recorder: RecorderController,
    pub(super) commands: HeapProd<EngineCommand>,
    pub(super) retired_mixers: HeapCons<Box<NativeMixerRuntime>>,
    pub(super) retired_auditions: HeapCons<Box<AuditionPlayback>>,
    pub(super) meter_bank: Arc<MeterBank>,
    pub(super) transport: Arc<TransportShared>,
    pub(super) input_peaks: Arc<InputPeakBank>,
    pub(super) round_trip_latency: Arc<RoundTripLatencyMeasurement>,
}

pub(super) struct OutputMixerControl {
    pub(super) commands: HeapCons<EngineCommand>,
    pub(super) mixer: Option<Box<NativeMixerRuntime>>,
    pub(super) retired_mixers: HeapProd<Box<NativeMixerRuntime>>,
    pub(super) retired_auditions: HeapProd<Box<AuditionPlayback>>,
}

pub(super) struct OutputStreamContext {
    pub(super) metrics: Arc<RuntimeMetrics>,
    pub(super) mixer_control: OutputMixerControl,
    pub(super) round_trip_latency: Arc<RoundTripLatencyMeasurement>,
    pub(super) recording_tap: RecordingTap,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AudioEngineKey {
    pub(super) backend: String,
    pub(super) input_device_id: String,
    pub(super) output_device_id: String,
    pub(super) requested_buffer_size: u32,
    pub(super) requested_session_sample_rate: Option<u32>,
}

impl RunningAudioEngine {
    pub(super) fn matches(&self, key: &AudioEngineKey) -> bool {
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

    pub(super) fn reclaim_retired_mixers(&mut self) -> usize {
        let mut reclaimed = 0;
        while self.retired_mixers.try_pop().is_some() {
            reclaimed += 1;
        }
        reclaimed
    }

    pub(super) fn reclaim_retired_auditions(&mut self) -> usize {
        let mut reclaimed = 0;
        while self.retired_auditions.try_pop().is_some() {
            reclaimed += 1;
        }
        reclaimed
    }
}

pub(super) fn take_pending_mixer(
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

pub(super) fn audio_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

pub(super) fn invalid_config(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}
