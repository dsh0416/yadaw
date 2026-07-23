use std::{
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    time::Duration,
};

use cpal::{
    BufferSize, Device, FromSample, Host, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
    SupportedBufferSize, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use napi::{Error, Result, Status};
use napi_derive::napi;
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};

use crate::recording::{
    NativeRecordingResult, NativeRecordingStartConfig, RecorderController, RecordingTap,
    StereoFrame,
};

const UNKNOWN_LATENCY_US: u64 = u64::MAX;
const RING_BUFFER_BLOCKS: usize = 8;
static AUDIO_ENGINE: OnceLock<Mutex<Option<AudioEngine>>> = OnceLock::new();

#[napi(object)]
pub struct NativeAudioEngineConfig {
    pub backend: String,
    pub input_device_id: String,
    pub output_device_id: String,
    pub buffer_size: u32,
}

#[napi(object)]
pub struct NativeAudioRuntimeSnapshot {
    pub state: String,
    pub requested_buffer_size: Option<u32>,
    pub sample_rate: Option<u32>,
    pub input_sample_rate: Option<u32>,
    pub input_buffer_size: Option<u32>,
    pub output_buffer_size: Option<u32>,
    pub ring_buffer_capacity_frames: Option<u32>,
    pub ring_buffer_fill_frames: Option<u32>,
    pub input_latency_ms: Option<f64>,
    pub output_latency_ms: Option<f64>,
    pub ring_buffer_latency_ms: Option<f64>,
    pub engine_latency_ms: Option<f64>,
    pub estimated_round_trip_latency_ms: Option<f64>,
    pub xruns: u32,
    pub clock_sync: String,
    pub buffer_fallback: bool,
}

struct RuntimeMetrics {
    requested_buffer_size: u32,
    sample_rate: u32,
    input_sample_rate: u32,
    input_buffer_size: AtomicU32,
    output_buffer_size: AtomicU32,
    ring_buffer_capacity_frames: u32,
    ring_buffer_fill_frames: AtomicU32,
    input_latency_us: AtomicU64,
    output_latency_us: AtomicU64,
    xruns: AtomicU32,
    faulted: AtomicBool,
    buffer_fallback: AtomicBool,
    clock_sync: &'static str,
}

impl RuntimeMetrics {
    fn snapshot(&self) -> NativeAudioRuntimeSnapshot {
        let input_latency_us = optional_latency(self.input_latency_us.load(Ordering::Relaxed));
        let output_latency_us = optional_latency(self.output_latency_us.load(Ordering::Relaxed));
        let ring_fill = self.ring_buffer_fill_frames.load(Ordering::Relaxed);
        let ring_latency_ms = frames_to_ms(ring_fill, self.input_sample_rate);
        let engine_latency_ms = if self.clock_sync == "adaptive-resampled" {
            frames_to_ms(1, self.input_sample_rate)
        } else {
            0.0
        };
        let estimated_round_trip_latency_ms =
            input_latency_us
                .zip(output_latency_us)
                .map(|(input_us, output_us)| {
                    input_us as f64 / 1_000.0
                        + output_us as f64 / 1_000.0
                        + ring_latency_ms
                        + engine_latency_ms
                });

        NativeAudioRuntimeSnapshot {
            state: if self.faulted.load(Ordering::Relaxed) {
                "error".to_owned()
            } else {
                "running".to_owned()
            },
            requested_buffer_size: Some(self.requested_buffer_size),
            sample_rate: Some(self.sample_rate),
            input_sample_rate: Some(self.input_sample_rate),
            input_buffer_size: Some(self.input_buffer_size.load(Ordering::Relaxed)),
            output_buffer_size: Some(self.output_buffer_size.load(Ordering::Relaxed)),
            ring_buffer_capacity_frames: Some(self.ring_buffer_capacity_frames),
            ring_buffer_fill_frames: Some(ring_fill),
            input_latency_ms: input_latency_us.map(|value| value as f64 / 1_000.0),
            output_latency_ms: output_latency_us.map(|value| value as f64 / 1_000.0),
            ring_buffer_latency_ms: Some(ring_latency_ms),
            engine_latency_ms: Some(engine_latency_ms),
            estimated_round_trip_latency_ms,
            xruns: self.xruns.load(Ordering::Relaxed),
            clock_sync: self.clock_sync.to_owned(),
            buffer_fallback: self.buffer_fallback.load(Ordering::Relaxed),
        }
    }
}

struct AudioEngine {
    _input_stream: Stream,
    _output_stream: Stream,
    metrics: Arc<RuntimeMetrics>,
    key: AudioEngineKey,
    recorder: RecorderController,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AudioEngineKey {
    backend: String,
    input_device_id: String,
    output_device_id: String,
    requested_buffer_size: u32,
}

impl AudioEngine {
    fn matches(&self, key: &AudioEngineKey) -> bool {
        self.key.backend == key.backend
            && self.key.input_device_id == key.input_device_id
            && self.key.output_device_id == key.output_device_id
            && (self.key.requested_buffer_size == key.requested_buffer_size
                || self.metrics.input_buffer_size.load(Ordering::Relaxed)
                    == key.requested_buffer_size
                || self.metrics.output_buffer_size.load(Ordering::Relaxed)
                    == key.requested_buffer_size)
            && !self.metrics.faulted.load(Ordering::Relaxed)
    }
}

fn engine_slot() -> &'static Mutex<Option<AudioEngine>> {
    AUDIO_ENGINE.get_or_init(|| Mutex::new(None))
}

fn audio_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn invalid_config(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn host_for_backend(backend: &str) -> Result<Host> {
    let host_id = cpal::available_hosts()
        .into_iter()
        .find(|host_id| host_id.to_string().eq_ignore_ascii_case(backend))
        .ok_or_else(|| invalid_config(format!("cpal backend '{backend}' is not available")))?;

    cpal::host_from_id(host_id)
        .map_err(|error| audio_error("failed to initialize cpal host", error))
}

fn find_device(host: &Host, id: &str, input: bool) -> Result<Device> {
    let devices = if input {
        host.input_devices()
            .map_err(|error| audio_error("failed to enumerate input devices", error))?
            .collect::<Vec<_>>()
    } else {
        host.output_devices()
            .map_err(|error| audio_error("failed to enumerate output devices", error))?
            .collect::<Vec<_>>()
    };

    devices
        .into_iter()
        .find(|device| {
            device
                .id()
                .is_ok_and(|device_id| device_id.to_string() == id)
        })
        .ok_or_else(|| invalid_config(format!("audio device '{id}' is no longer available")))
}

struct BufferSelection {
    buffer_size: BufferSize,
    expected_frames: u32,
    fell_back: bool,
}

fn select_buffer_size(supported: &SupportedBufferSize, requested: u32) -> BufferSelection {
    match supported {
        SupportedBufferSize::Range { min, max } => {
            let selected = requested.clamp(*min, *max);
            if selected == requested {
                BufferSelection {
                    buffer_size: BufferSize::Fixed(selected),
                    expected_frames: selected,
                    fell_back: false,
                }
            } else {
                BufferSelection {
                    buffer_size: BufferSize::Default,
                    expected_frames: selected,
                    fell_back: true,
                }
            }
        }
        SupportedBufferSize::Unknown => BufferSelection {
            buffer_size: BufferSize::Default,
            expected_frames: requested,
            fell_back: true,
        },
    }
}

fn stream_config(
    config: &SupportedStreamConfig,
    requested_buffer_size: u32,
) -> (StreamConfig, BufferSelection) {
    let selection = select_buffer_size(config.buffer_size(), requested_buffer_size);
    let mut stream_config = config.config();
    stream_config.buffer_size = selection.buffer_size;
    (stream_config, selection)
}

fn duration_to_micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX - 1)) as u64
}

fn optional_latency(value: u64) -> Option<u64> {
    (value != UNKNOWN_LATENCY_US).then_some(value)
}

fn frames_to_ms(frames: u32, sample_rate: u32) -> f64 {
    f64::from(frames) / f64::from(sample_rate) * 1_000.0
}

fn mark_stream_error(metrics: &RuntimeMetrics) {
    metrics.xruns.fetch_add(1, Ordering::Relaxed);
    metrics.faulted.store(true, Ordering::Relaxed);
}

struct AdaptiveResampler {
    consumer: HeapCons<StereoFrame>,
    current: StereoFrame,
    next: StereoFrame,
    phase: f64,
    nominal_ratio: f64,
    target_fill: usize,
    capacity: usize,
    primed: bool,
}

impl AdaptiveResampler {
    fn new(
        consumer: HeapCons<StereoFrame>,
        input_sample_rate: u32,
        output_sample_rate: u32,
        target_fill: usize,
        capacity: usize,
    ) -> Self {
        Self {
            consumer,
            current: [0.0, 0.0],
            next: [0.0, 0.0],
            phase: 0.0,
            nominal_ratio: f64::from(input_sample_rate) / f64::from(output_sample_rate),
            target_fill,
            capacity,
            primed: false,
        }
    }

    fn occupied_len(&self) -> usize {
        self.consumer.occupied_len()
    }

    fn adaptive_ratio(&self) -> f64 {
        let fill_error = self.occupied_len() as f64 - self.target_fill as f64;
        let normalized_error = fill_error / self.capacity.max(1) as f64;
        let drift_correction = (normalized_error * 0.002).clamp(-0.001, 0.001);
        self.nominal_ratio * (1.0 + drift_correction)
    }

    fn next_frame(&mut self, ratio: f64) -> Option<StereoFrame> {
        if !self.primed {
            self.current = self.consumer.try_pop()?;
            self.next = self.consumer.try_pop()?;
            self.phase = 0.0;
            self.primed = true;
        }

        let output = [
            self.current[0] + (self.next[0] - self.current[0]) * self.phase as f32,
            self.current[1] + (self.next[1] - self.current[1]) * self.phase as f32,
        ];
        self.phase += ratio;

        while self.phase >= 1.0 {
            let Some(next) = self.consumer.try_pop() else {
                self.primed = false;
                self.phase = 0.0;
                break;
            };
            self.current = self.next;
            self.next = next;
            self.phase -= 1.0;
        }

        Some(output)
    }
}

fn build_input_stream<T>(
    device: &Device,
    config: &StreamConfig,
    mut producer: HeapProd<StereoFrame>,
    metrics: Arc<RuntimeMetrics>,
    mut recording_tap: RecordingTap,
) -> Result<Stream>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    let callback_metrics = Arc::clone(&metrics);
    let error_metrics = Arc::clone(&metrics);

    device
        .build_input_stream(
            *config,
            move |data: &[T], info| {
                let timestamp = info.timestamp();
                callback_metrics.input_latency_us.store(
                    duration_to_micros(timestamp.callback.duration_since(timestamp.capture)),
                    Ordering::Relaxed,
                );

                let mut overrun = false;
                for frame in data.chunks_exact(channels) {
                    let left = f32::from_sample(frame[0]);
                    let right = if channels > 1 {
                        f32::from_sample(frame[1])
                    } else {
                        left
                    };
                    if producer.try_push([left, right]).is_err() {
                        overrun = true;
                    }
                    recording_tap.push([left, right]);
                }

                callback_metrics
                    .ring_buffer_fill_frames
                    .store(producer.occupied_len() as u32, Ordering::Relaxed);
                if overrun {
                    callback_metrics.xruns.fetch_add(1, Ordering::Relaxed);
                }
            },
            move |_error| mark_stream_error(&error_metrics),
            None,
        )
        .map_err(|error| audio_error("failed to build cpal input stream", error))
}

fn build_output_stream<T>(
    device: &Device,
    config: &StreamConfig,
    consumer: HeapCons<StereoFrame>,
    target_fill: usize,
    metrics: Arc<RuntimeMetrics>,
) -> Result<Stream>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let channels = usize::from(config.channels);
    let mut resampler = AdaptiveResampler::new(
        consumer,
        metrics.input_sample_rate,
        metrics.sample_rate,
        target_fill,
        metrics.ring_buffer_capacity_frames as usize,
    );
    let callback_metrics = Arc::clone(&metrics);
    let error_metrics = Arc::clone(&metrics);

    device
        .build_output_stream(
            *config,
            move |data: &mut [T], info| {
                let timestamp = info.timestamp();
                callback_metrics.output_latency_us.store(
                    duration_to_micros(timestamp.playback.duration_since(timestamp.callback)),
                    Ordering::Relaxed,
                );

                let mut underrun = false;
                let ratio = resampler.adaptive_ratio();
                for frame in data.chunks_exact_mut(channels) {
                    let input = resampler.next_frame(ratio).unwrap_or_else(|| {
                        underrun = true;
                        [0.0, 0.0]
                    });
                    for (channel, sample) in frame.iter_mut().enumerate() {
                        // The graph is not armed for input monitoring yet. Consume the bridge
                        // exactly as the future graph will, but keep the physical output silent.
                        let _input_sample = match channel {
                            0 => input[0],
                            1 => input[1],
                            _ => 0.0,
                        };
                        let value = 0.0;
                        *sample = T::from_sample(value);
                    }
                }

                callback_metrics
                    .ring_buffer_fill_frames
                    .store(resampler.occupied_len() as u32, Ordering::Relaxed);
                if underrun {
                    callback_metrics.xruns.fetch_add(1, Ordering::Relaxed);
                }
            },
            move |_error| mark_stream_error(&error_metrics),
            None,
        )
        .map_err(|error| audio_error("failed to build cpal output stream", error))
}

macro_rules! build_stream_for_format {
    ($builder:ident, $format:expr, $($args:expr),+ $(,)?) => {
        match $format {
            SampleFormat::I8 => $builder::<i8>($($args),+),
            SampleFormat::I16 => $builder::<i16>($($args),+),
            SampleFormat::I24 => $builder::<cpal::I24>($($args),+),
            SampleFormat::I32 => $builder::<i32>($($args),+),
            SampleFormat::I64 => $builder::<i64>($($args),+),
            SampleFormat::U8 => $builder::<u8>($($args),+),
            SampleFormat::U16 => $builder::<u16>($($args),+),
            SampleFormat::U24 => $builder::<cpal::U24>($($args),+),
            SampleFormat::U32 => $builder::<u32>($($args),+),
            SampleFormat::U64 => $builder::<u64>($($args),+),
            SampleFormat::F32 => $builder::<f32>($($args),+),
            SampleFormat::F64 => $builder::<f64>($($args),+),
            SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => {
                Err(invalid_config("DSD audio streams are not supported"))
            }
            _ => Err(invalid_config("unsupported cpal sample format")),
        }
    };
}

fn stopped_snapshot() -> NativeAudioRuntimeSnapshot {
    NativeAudioRuntimeSnapshot {
        state: "stopped".to_owned(),
        requested_buffer_size: None,
        sample_rate: None,
        input_sample_rate: None,
        input_buffer_size: None,
        output_buffer_size: None,
        ring_buffer_capacity_frames: None,
        ring_buffer_fill_frames: None,
        input_latency_ms: None,
        output_latency_ms: None,
        ring_buffer_latency_ms: None,
        engine_latency_ms: None,
        estimated_round_trip_latency_ms: None,
        xruns: 0,
        clock_sync: "inactive".to_owned(),
        buffer_fallback: false,
    }
}

#[napi]
pub fn start_audio_engine(config: NativeAudioEngineConfig) -> Result<NativeAudioRuntimeSnapshot> {
    if config.buffer_size == 0 {
        return Err(invalid_config("buffer size must be greater than zero"));
    }

    let engine_key = AudioEngineKey {
        backend: config.backend.clone(),
        input_device_id: config.input_device_id.clone(),
        output_device_id: config.output_device_id.clone(),
        requested_buffer_size: config.buffer_size,
    };

    {
        let guard = engine_slot()
            .lock()
            .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
        if let Some(engine) = guard.as_ref().filter(|engine| engine.matches(&engine_key)) {
            return Ok(engine.metrics.snapshot());
        }
    }

    // Only release devices when the requested configuration genuinely changed.
    *engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))? = None;

    let host = host_for_backend(&config.backend)?;
    let input_device = find_device(&host, &config.input_device_id, true)?;
    let output_device = find_device(&host, &config.output_device_id, false)?;
    let input_supported = input_device
        .default_input_config()
        .map_err(|error| audio_error("failed to read default input configuration", error))?;
    let output_supported = output_device
        .default_output_config()
        .map_err(|error| audio_error("failed to read default output configuration", error))?;

    let (input_config, input_buffer) = stream_config(&input_supported, config.buffer_size);
    let (output_config, output_buffer) = stream_config(&output_supported, config.buffer_size);
    let bridge_block_size = input_buffer
        .expected_frames
        .max(output_buffer.expected_frames);
    let ring_capacity = (bridge_block_size as usize * RING_BUFFER_BLOCKS).max(256);
    let ring = HeapRb::<StereoFrame>::new(ring_capacity);
    let (mut producer, consumer) = ring.split();
    for _ in 0..bridge_block_size {
        producer
            .try_push([0.0, 0.0])
            .map_err(|_| audio_error("failed to prime ring buffer", "buffer is full"))?;
    }
    let metrics = Arc::new(RuntimeMetrics {
        requested_buffer_size: config.buffer_size,
        sample_rate: output_config.sample_rate,
        input_sample_rate: input_config.sample_rate,
        input_buffer_size: AtomicU32::new(input_buffer.expected_frames),
        output_buffer_size: AtomicU32::new(output_buffer.expected_frames),
        ring_buffer_capacity_frames: ring_capacity as u32,
        ring_buffer_fill_frames: AtomicU32::new(bridge_block_size),
        input_latency_us: AtomicU64::new(UNKNOWN_LATENCY_US),
        output_latency_us: AtomicU64::new(UNKNOWN_LATENCY_US),
        xruns: AtomicU32::new(0),
        faulted: AtomicBool::new(false),
        buffer_fallback: AtomicBool::new(input_buffer.fell_back || output_buffer.fell_back),
        clock_sync: if config.input_device_id == config.output_device_id
            && input_config.sample_rate == output_config.sample_rate
        {
            "shared-device"
        } else {
            "adaptive-resampled"
        },
    });
    let (recorder, recording_tap) = RecorderController::new(input_config.sample_rate);

    let input_stream = build_stream_for_format!(
        build_input_stream,
        input_supported.sample_format(),
        &input_device,
        &input_config,
        producer,
        Arc::clone(&metrics),
        recording_tap,
    )?;
    let output_stream = build_stream_for_format!(
        build_output_stream,
        output_supported.sample_format(),
        &output_device,
        &output_config,
        consumer,
        bridge_block_size as usize,
        Arc::clone(&metrics),
    )?;

    let actual_input_buffer = input_stream
        .buffer_size()
        .unwrap_or(input_buffer.expected_frames);
    let actual_output_buffer = output_stream
        .buffer_size()
        .unwrap_or(output_buffer.expected_frames);
    metrics
        .input_buffer_size
        .store(actual_input_buffer, Ordering::Relaxed);
    metrics
        .output_buffer_size
        .store(actual_output_buffer, Ordering::Relaxed);
    if actual_input_buffer != config.buffer_size || actual_output_buffer != config.buffer_size {
        metrics.buffer_fallback.store(true, Ordering::Relaxed);
    }

    input_stream
        .play()
        .map_err(|error| audio_error("failed to start cpal input stream", error))?;
    output_stream
        .play()
        .map_err(|error| audio_error("failed to start cpal output stream", error))?;

    let engine = AudioEngine {
        _input_stream: input_stream,
        _output_stream: output_stream,
        metrics,
        key: engine_key,
        recorder,
    };
    let snapshot = engine.metrics.snapshot();
    *engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))? = Some(engine);

    Ok(snapshot)
}

#[napi]
pub fn stop_audio_engine() -> Result<NativeAudioRuntimeSnapshot> {
    *engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))? = None;
    Ok(stopped_snapshot())
}

#[napi]
pub fn audio_engine_snapshot() -> Result<NativeAudioRuntimeSnapshot> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    Ok(guard
        .as_ref()
        .map_or_else(stopped_snapshot, |engine| engine.metrics.snapshot()))
}

#[napi]
pub fn start_recording(config: NativeRecordingStartConfig) -> Result<()> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("audio engine must be running before recording"))?;
    engine.recorder.start(config)
}

#[napi]
pub fn stop_recording() -> Result<NativeRecordingResult> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("audio engine is not running"))?;
    engine.recorder.stop()
}

#[cfg(test)]
mod tests {
    use super::{
        AdaptiveResampler, BufferSelection, BufferSize, SupportedBufferSize, select_buffer_size,
    };
    use ringbuf::{
        HeapRb,
        traits::{Producer, Split},
    };

    fn assert_fixed(selection: BufferSelection, expected: u32, fell_back: bool) {
        assert!(matches!(selection.buffer_size, BufferSize::Fixed(value) if value == expected));
        assert_eq!(selection.expected_frames, expected);
        assert_eq!(selection.fell_back, fell_back);
    }

    #[test]
    fn keeps_a_supported_requested_buffer_size() {
        assert_fixed(
            select_buffer_size(&SupportedBufferSize::Range { min: 32, max: 512 }, 64),
            64,
            false,
        );
    }

    #[test]
    fn falls_back_to_the_driver_default_outside_the_device_range() {
        let selection = select_buffer_size(&SupportedBufferSize::Range { min: 480, max: 480 }, 64);
        assert!(matches!(selection.buffer_size, BufferSize::Default));
        assert_eq!(selection.expected_frames, 480);
        assert!(selection.fell_back);
    }

    #[test]
    fn uses_the_driver_default_when_the_range_is_unknown() {
        let selection = select_buffer_size(&SupportedBufferSize::Unknown, 64);
        assert!(matches!(selection.buffer_size, BufferSize::Default));
        assert_eq!(selection.expected_frames, 64);
        assert!(selection.fell_back);
    }

    #[test]
    fn interpolates_between_input_frames_without_callback_allocations() {
        let ring = HeapRb::new(8);
        let (mut producer, consumer) = ring.split();
        producer.try_push([0.0, 0.0]).unwrap();
        producer.try_push([1.0, 1.0]).unwrap();
        producer.try_push([2.0, 2.0]).unwrap();
        let mut resampler = AdaptiveResampler::new(consumer, 48_000, 44_100, 1, 8);

        assert_eq!(resampler.next_frame(0.5), Some([0.0, 0.0]));
        assert_eq!(resampler.next_frame(0.5), Some([0.5, 0.5]));
        assert_eq!(resampler.next_frame(0.5), Some([1.0, 1.0]));
    }
}
