use std::{
    fs,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use bwavfile::WaveReader;
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
use yadaw_dsp_core::mixer::{
    ChannelKind, ChannelPeak, ChannelSpec, HardwareOutputFrame, MAX_OUTPUT_CHANNELS, MixerGraph,
    SendSpec, SendTap,
};

use crate::recording::{
    MAX_INPUT_CHANNELS, NativeRecordingResult, NativeRecordingStartConfig, NativeWaveformSnapshot,
    RecorderController, RecordingTap, StereoFrame,
};

const UNKNOWN_LATENCY_US: u64 = u64::MAX;
const RING_BUFFER_BLOCKS: usize = 8;
static AUDIO_ENGINE: OnceLock<Mutex<Option<AudioEngine>>> = OnceLock::new();
static PENDING_MIXER: OnceLock<Mutex<Option<Box<NativeMixerRuntime>>>> = OnceLock::new();

const ENGINE_COMMAND_CAPACITY: usize = 256;
const MEMORY_DECODE_LIMIT_BYTES: u64 = 32 * 1024 * 1024;
const STREAM_WINDOW_SECONDS: usize = 2;
const TRANSPORT_STOPPED: u32 = 0;
const TRANSPORT_PLAYING: u32 = 1;
const TRANSPORT_RECORDING: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClipStoragePolicy {
    Memory,
    Streaming,
}

fn clip_storage_policy(file_size: u64) -> ClipStoragePolicy {
    if file_size <= MEMORY_DECODE_LIMIT_BYTES {
        ClipStoragePolicy::Memory
    } else {
        ClipStoragePolicy::Streaming
    }
}

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

#[napi(object)]
#[derive(Clone)]
pub struct NativeMixerChannel {
    pub id: String,
    pub kind: String,
    pub gain_db: f64,
    pub pan: f64,
    pub muted: bool,
    pub soloed: bool,
    pub output_index: Option<u32>,
    pub record_armed: bool,
    pub input_channels: Vec<u32>,
    pub hardware_output_channels: Vec<u32>,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeMixerSend {
    pub id: String,
    pub source_index: u32,
    pub target_index: u32,
    pub enabled: bool,
    pub tap: String,
    pub level_db: f64,
    pub pan: f64,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeMixerClip {
    pub id: String,
    pub track_input_index: u32,
    pub start_frame: i64,
    pub source_offset_frames: i64,
    pub length_frames: i64,
    pub path: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeMixerGraph {
    pub sample_rate: u32,
    pub channels: Vec<NativeMixerChannel>,
    pub sends: Vec<NativeMixerSend>,
    pub clips: Vec<NativeMixerClip>,
}

#[napi(object)]
pub struct NativeMixerParameterPreview {
    pub target: String,
    pub id: String,
    pub parameter: String,
    pub value: f64,
}

#[napi(object)]
pub struct NativeMixerChannelMeter {
    pub channel_id: String,
    pub pre_left: f64,
    pub pre_right: f64,
    pub post_left: f64,
    pub post_right: f64,
    pub held_left: f64,
    pub held_right: f64,
    pub clipped: bool,
}

#[napi(object)]
pub struct NativeMixerSnapshot {
    pub meters: Vec<NativeMixerChannelMeter>,
}

#[napi(object)]
pub struct NativeTransportSnapshot {
    pub state: String,
    pub position_frames: i64,
    pub sample_rate: u32,
}

struct TransportShared {
    state: AtomicU32,
    position_frames: AtomicU64,
    sample_rate: AtomicU32,
}

impl TransportShared {
    fn snapshot(&self) -> NativeTransportSnapshot {
        NativeTransportSnapshot {
            state: match self.state.load(Ordering::Relaxed) {
                TRANSPORT_PLAYING => "playing",
                TRANSPORT_RECORDING => "recording",
                _ => "stopped",
            }
            .to_owned(),
            position_frames: self
                .position_frames
                .load(Ordering::Relaxed)
                .min(i64::MAX as u64) as i64,
            sample_rate: self.sample_rate.load(Ordering::Relaxed),
        }
    }
}

struct MeterAtomics {
    id: String,
    pre_left: AtomicU32,
    pre_right: AtomicU32,
    post_left: AtomicU32,
    post_right: AtomicU32,
    held_left: AtomicU32,
    held_right: AtomicU32,
    clipped: AtomicBool,
}

impl MeterAtomics {
    fn new(id: String) -> Self {
        Self {
            id,
            pre_left: AtomicU32::new(0.0_f32.to_bits()),
            pre_right: AtomicU32::new(0.0_f32.to_bits()),
            post_left: AtomicU32::new(0.0_f32.to_bits()),
            post_right: AtomicU32::new(0.0_f32.to_bits()),
            held_left: AtomicU32::new(0.0_f32.to_bits()),
            held_right: AtomicU32::new(0.0_f32.to_bits()),
            clipped: AtomicBool::new(false),
        }
    }

    fn store(&self, peak: ChannelPeak, held: StereoFrame) {
        self.pre_left
            .store(peak.pre[0].to_bits(), Ordering::Relaxed);
        self.pre_right
            .store(peak.pre[1].to_bits(), Ordering::Relaxed);
        self.post_left
            .store(peak.post[0].to_bits(), Ordering::Relaxed);
        self.post_right
            .store(peak.post[1].to_bits(), Ordering::Relaxed);
        self.held_left.store(held[0].to_bits(), Ordering::Relaxed);
        self.held_right.store(held[1].to_bits(), Ordering::Relaxed);
        if held[0] >= 1.0 || held[1] >= 1.0 {
            self.clipped.store(true, Ordering::Relaxed);
        }
    }

    fn snapshot(&self) -> NativeMixerChannelMeter {
        NativeMixerChannelMeter {
            channel_id: self.id.clone(),
            pre_left: f64::from(f32::from_bits(self.pre_left.load(Ordering::Relaxed))),
            pre_right: f64::from(f32::from_bits(self.pre_right.load(Ordering::Relaxed))),
            post_left: f64::from(f32::from_bits(self.post_left.load(Ordering::Relaxed))),
            post_right: f64::from(f32::from_bits(self.post_right.load(Ordering::Relaxed))),
            held_left: f64::from(f32::from_bits(self.held_left.load(Ordering::Relaxed))),
            held_right: f64::from(f32::from_bits(self.held_right.load(Ordering::Relaxed))),
            clipped: self.clipped.load(Ordering::Relaxed),
        }
    }

    fn clear_clip(&self) {
        self.clipped.store(false, Ordering::Relaxed);
        self.held_left.store(0.0_f32.to_bits(), Ordering::Relaxed);
        self.held_right.store(0.0_f32.to_bits(), Ordering::Relaxed);
    }
}

struct MeterBank {
    channels: Vec<MeterAtomics>,
}

struct InputPeakBank {
    peaks: [AtomicU32; MAX_INPUT_CHANNELS],
}

impl InputPeakBank {
    fn new() -> Self {
        Self {
            peaks: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }

    fn observe(&self, channels: &[f32]) {
        for (peak, sample) in self.peaks.iter().zip(channels) {
            peak.fetch_max(sample.abs().to_bits(), Ordering::Relaxed);
        }
    }

    fn take_all(&self, target: &mut [f32; MAX_INPUT_CHANNELS]) {
        for (target, peak) in target.iter_mut().zip(&self.peaks) {
            *target = f32::from_bits(peak.swap(0, Ordering::Relaxed));
        }
    }
}

struct AtomicSampleWindow {
    samples: Box<[AtomicU32]>,
    start_frame: AtomicU64,
    frame_count: AtomicUsize,
    generation: AtomicU64,
}

impl AtomicSampleWindow {
    fn new(capacity_frames: usize) -> Self {
        Self {
            samples: (0..capacity_frames.saturating_mul(2))
                .map(|_| AtomicU32::new(0))
                .collect(),
            start_frame: AtomicU64::new(0),
            frame_count: AtomicUsize::new(0),
            generation: AtomicU64::new(0),
        }
    }

    fn store(&self, frame: usize, sample: StereoFrame) {
        self.samples[frame * 2].store(sample[0].to_bits(), Ordering::Relaxed);
        self.samples[frame * 2 + 1].store(sample[1].to_bits(), Ordering::Relaxed);
    }

    fn load(&self, frame: usize) -> StereoFrame {
        [
            f32::from_bits(self.samples[frame * 2].load(Ordering::Relaxed)),
            f32::from_bits(self.samples[frame * 2 + 1].load(Ordering::Relaxed)),
        ]
    }
}

struct StreamControl {
    windows: [AtomicSampleWindow; 2],
    active_window: AtomicUsize,
    reader_window: AtomicUsize,
    requested_frame: AtomicU64,
    generation: AtomicU64,
    shutdown: AtomicBool,
}

impl StreamControl {
    fn new(capacity_frames: usize, initial_frame: usize) -> Self {
        Self {
            windows: [
                AtomicSampleWindow::new(capacity_frames),
                AtomicSampleWindow::new(capacity_frames),
            ],
            active_window: AtomicUsize::new(0),
            reader_window: AtomicUsize::new(0),
            requested_frame: AtomicU64::new(initial_frame as u64),
            generation: AtomicU64::new(1),
            shutdown: AtomicBool::new(false),
        }
    }
}

struct StreamingClip {
    control: Arc<StreamControl>,
    worker: Option<JoinHandle<()>>,
    expected_frame: Option<usize>,
}

impl StreamingClip {
    fn sample_at(&mut self, frame: usize) -> Option<StereoFrame> {
        if self.expected_frame != Some(frame) {
            self.control.generation.fetch_add(1, Ordering::AcqRel);
        }
        self.expected_frame = frame.checked_add(1);
        self.control
            .requested_frame
            .store(frame as u64, Ordering::Release);

        for _ in 0..2 {
            let active = self.control.active_window.load(Ordering::Acquire);
            self.control
                .reader_window
                .store(active + 1, Ordering::Release);
            if active != self.control.active_window.load(Ordering::Acquire) {
                self.control.reader_window.store(0, Ordering::Release);
                continue;
            }
            let window = &self.control.windows[active];
            let generation = window.generation.load(Ordering::Acquire);
            let start = window.start_frame.load(Ordering::Relaxed) as usize;
            let count = window.frame_count.load(Ordering::Relaxed);
            let sample = (generation == self.control.generation.load(Ordering::Acquire)
                && frame >= start
                && frame < start.saturating_add(count))
            .then(|| window.load(frame - start));
            self.control.reader_window.store(0, Ordering::Release);
            return sample;
        }
        None
    }
}

impl Drop for StreamingClip {
    fn drop(&mut self) {
        self.control.shutdown.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

enum ClipSamples {
    Memory(Vec<StereoFrame>),
    Streaming(StreamingClip),
}

struct LoadedClip {
    track_input_index: usize,
    start_frame: u64,
    source_offset_frames: usize,
    length_frames: usize,
    samples: ClipSamples,
}

impl LoadedClip {
    fn sample_at(&mut self, relative: usize) -> Option<StereoFrame> {
        let source_frame = self.source_offset_frames.checked_add(relative)?;
        match &mut self.samples {
            ClipSamples::Memory(samples) => samples.get(source_frame).copied(),
            ClipSamples::Streaming(stream) => stream.sample_at(source_frame),
        }
    }
}

struct NativeMixerRuntime {
    graph: MixerGraph,
    clips: Vec<LoadedClip>,
    audio_inputs: Vec<StereoFrame>,
    peak_scratch: Vec<ChannelPeak>,
    held_peaks: Vec<StereoFrame>,
    held_until: Vec<[u64; 2]>,
    meter_bank: Arc<MeterBank>,
    transport: Arc<TransportShared>,
    sample_rate: u32,
    content_end_frame: u64,
    input_peaks: Arc<InputPeakBank>,
    input_meter_routes: Vec<Option<[usize; 2]>>,
    input_peak_scratch: [f32; MAX_INPUT_CHANNELS],
    meter_frame_clock: u64,
}

#[derive(Clone, Copy)]
enum RealtimeParameter {
    ChannelGain,
    ChannelPan,
    SendLevel,
    SendPan,
}

#[derive(Clone, Copy)]
struct RealtimeParameterCommand {
    id: [u8; 64],
    id_len: u8,
    parameter: RealtimeParameter,
    value: f32,
}

impl RealtimeParameterCommand {
    fn from_preview(preview: NativeMixerParameterPreview) -> Result<Self> {
        let parameter = match (preview.target.as_str(), preview.parameter.as_str()) {
            ("channel", "gainDb") => RealtimeParameter::ChannelGain,
            ("channel", "pan") => RealtimeParameter::ChannelPan,
            ("send", "levelDb") => RealtimeParameter::SendLevel,
            ("send", "pan") => RealtimeParameter::SendPan,
            _ => return Err(invalid_config("unknown mixer preview parameter")),
        };
        let bytes = preview.id.as_bytes();
        if bytes.len() > 64 {
            return Err(invalid_config("mixer identifier is too long"));
        }
        let mut id = [0_u8; 64];
        id[..bytes.len()].copy_from_slice(bytes);
        Ok(Self {
            id,
            id_len: bytes.len() as u8,
            parameter,
            value: preview.value as f32,
        })
    }

    fn id(&self) -> &str {
        std::str::from_utf8(&self.id[..usize::from(self.id_len)]).unwrap_or("")
    }
}

#[derive(Clone, Copy)]
enum TransportAction {
    Play,
    Pause,
    Stop,
    Seek,
    Record,
}

enum EngineCommand {
    LoadMixer(Box<NativeMixerRuntime>),
    Preview(RealtimeParameterCommand),
    Transport(TransportAction, u64),
    ClearMeterClips,
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
    commands: HeapProd<EngineCommand>,
    retired_mixers: HeapCons<Box<NativeMixerRuntime>>,
    meter_bank: Arc<MeterBank>,
    transport: Arc<TransportShared>,
    input_peaks: Arc<InputPeakBank>,
}

struct OutputMixerControl {
    commands: HeapCons<EngineCommand>,
    mixer: Option<Box<NativeMixerRuntime>>,
    retired_mixers: HeapProd<Box<NativeMixerRuntime>>,
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

    fn reclaim_retired_mixers(&mut self) {
        while self.retired_mixers.try_pop().is_some() {}
    }
}

fn engine_slot() -> &'static Mutex<Option<AudioEngine>> {
    AUDIO_ENGINE.get_or_init(|| Mutex::new(None))
}

fn pending_mixer_slot() -> &'static Mutex<Option<Box<NativeMixerRuntime>>> {
    PENDING_MIXER.get_or_init(|| Mutex::new(None))
}

fn audio_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn invalid_config(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn decode_clip_audio(path: &str, target_sample_rate: u32) -> Result<Vec<StereoFrame>> {
    let mut reader =
        WaveReader::open(path).map_err(|error| audio_error("failed to open mixer clip", error))?;
    let format = reader
        .format()
        .map_err(|error| audio_error("failed to read mixer clip format", error))?;
    let frames = reader
        .frame_length()
        .map_err(|error| audio_error("failed to read mixer clip length", error))?
        as usize;
    let channels = usize::from(format.channel_count);
    if channels == 0 {
        return Err(invalid_config("mixer clip has no audio channels"));
    }
    let mut samples = vec![0.0_f32; frames.saturating_mul(channels)];
    let mut frame_reader = reader
        .audio_frame_reader()
        .map_err(|error| audio_error("failed to open mixer clip audio", error))?;
    let read_frames = frame_reader
        .read_frames(&mut samples)
        .map_err(|error| audio_error("failed to decode mixer clip", error))?
        as usize;
    samples.truncate(read_frames.saturating_mul(channels));
    let decoded: Vec<StereoFrame> = samples
        .chunks_exact(channels)
        .map(|frame| {
            let left = frame[0];
            let right = if channels > 1 { frame[1] } else { left };
            [left, right]
        })
        .collect();
    if decoded.is_empty() {
        return Ok(decoded);
    }
    if format.sample_rate == target_sample_rate {
        return Ok(decoded);
    }
    let target_frames = ((decoded.len() as u128 * u128::from(target_sample_rate)
        + u128::from(format.sample_rate) / 2)
        / u128::from(format.sample_rate)) as usize;
    let ratio = f64::from(format.sample_rate) / f64::from(target_sample_rate);
    Ok((0..target_frames)
        .map(|frame| {
            let position = frame as f64 * ratio;
            let base = position.floor() as usize;
            let next = (base + 1).min(decoded.len().saturating_sub(1));
            let fraction = (position - base as f64) as f32;
            let first = decoded[base.min(decoded.len().saturating_sub(1))];
            let second = decoded[next];
            [
                first[0] + (second[0] - first[0]) * fraction,
                first[1] + (second[1] - first[1]) * fraction,
            ]
        })
        .collect())
}

fn spawn_streaming_clip(
    path: String,
    target_sample_rate: u32,
    initial_frame: usize,
) -> Result<(StreamingClip, usize)> {
    let mut metadata_reader = WaveReader::open(&path)
        .map_err(|error| audio_error("failed to inspect streaming mixer clip", error))?;
    let format = metadata_reader
        .format()
        .map_err(|error| audio_error("failed to read streaming clip format", error))?;
    let source_frames = metadata_reader
        .frame_length()
        .map_err(|error| audio_error("failed to read streaming clip length", error))?
        as usize;
    let source_channels = usize::from(format.channel_count);
    if source_channels == 0 || format.sample_rate == 0 {
        return Err(invalid_config("streaming mixer clip has an invalid format"));
    }
    let target_frames = ((source_frames as u128 * u128::from(target_sample_rate)
        + u128::from(format.sample_rate) / 2)
        / u128::from(format.sample_rate)) as usize;
    let capacity = (target_sample_rate as usize)
        .saturating_mul(STREAM_WINDOW_SECONDS)
        .max(1);
    let control = Arc::new(StreamControl::new(capacity, initial_frame));
    let worker_control = Arc::clone(&control);
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("yadaw-clip-prefetch".to_owned())
        .spawn(move || {
            let mut ready_sender = Some(ready_sender);
            let result = (|| -> std::result::Result<(), String> {
                let reader = WaveReader::open(&path).map_err(|error| error.to_string())?;
                let mut frame_reader = reader
                    .audio_frame_reader()
                    .map_err(|error| error.to_string())?;
                let source_ratio = f64::from(format.sample_rate) / f64::from(target_sample_rate);
                let prefetch_threshold = (target_sample_rate as usize / 2).max(1);
                let overlap = (target_sample_rate as usize / 4).max(1);
                let mut source_buffer = Vec::<f32>::new();

                while !worker_control.shutdown.load(Ordering::Acquire) {
                    let generation = worker_control.generation.load(Ordering::Acquire);
                    let requested = worker_control.requested_frame.load(Ordering::Acquire) as usize;
                    let active = worker_control.active_window.load(Ordering::Acquire);
                    let active_window = &worker_control.windows[active];
                    let active_generation = active_window.generation.load(Ordering::Acquire);
                    let active_start = active_window.start_frame.load(Ordering::Relaxed) as usize;
                    let active_count = active_window.frame_count.load(Ordering::Relaxed);
                    let active_end = active_start.saturating_add(active_count);
                    let covered = active_generation == generation
                        && requested >= active_start
                        && requested < active_end;
                    if covered && active_end.saturating_sub(requested) > prefetch_threshold {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }

                    let window_start = if covered {
                        active_end.saturating_sub(overlap)
                    } else {
                        requested
                    };
                    let window_count = capacity.min(target_frames.saturating_sub(window_start));
                    let inactive = 1 - active;
                    while worker_control.reader_window.load(Ordering::Acquire) == inactive + 1
                        && !worker_control.shutdown.load(Ordering::Acquire)
                    {
                        thread::yield_now();
                    }
                    if worker_control.shutdown.load(Ordering::Acquire) {
                        break;
                    }

                    let source_start = (window_start as f64 * source_ratio).floor() as usize;
                    let source_end = (((window_start.saturating_add(window_count)) as f64
                        * source_ratio)
                        .ceil() as usize)
                        .saturating_add(1)
                        .min(source_frames);
                    let requested_source_frames = source_end.saturating_sub(source_start);
                    source_buffer
                        .resize(requested_source_frames.saturating_mul(source_channels), 0.0);
                    frame_reader
                        .locate(source_start as u64)
                        .map_err(|error| error.to_string())?;
                    let read_frames = frame_reader
                        .read_frames(&mut source_buffer)
                        .map_err(|error| error.to_string())?
                        as usize;
                    source_buffer.truncate(read_frames.saturating_mul(source_channels));

                    let window = &worker_control.windows[inactive];
                    let mut written = 0;
                    for output_index in 0..window_count {
                        if generation != worker_control.generation.load(Ordering::Acquire) {
                            break;
                        }
                        let source_position = (window_start + output_index) as f64 * source_ratio;
                        let base_source = source_position.floor() as usize;
                        let local = base_source.saturating_sub(source_start);
                        if local >= read_frames {
                            break;
                        }
                        let next = (local + 1).min(read_frames.saturating_sub(1));
                        let fraction = (source_position - base_source as f64) as f32;
                        let first_left = source_buffer[local * source_channels];
                        let second_left = source_buffer[next * source_channels];
                        let first_right = if source_channels > 1 {
                            source_buffer[local * source_channels + 1]
                        } else {
                            first_left
                        };
                        let second_right = if source_channels > 1 {
                            source_buffer[next * source_channels + 1]
                        } else {
                            second_left
                        };
                        window.store(
                            output_index,
                            [
                                first_left + (second_left - first_left) * fraction,
                                first_right + (second_right - first_right) * fraction,
                            ],
                        );
                        written += 1;
                    }
                    if generation != worker_control.generation.load(Ordering::Acquire) {
                        continue;
                    }
                    window
                        .start_frame
                        .store(window_start as u64, Ordering::Relaxed);
                    window.frame_count.store(written, Ordering::Relaxed);
                    window.generation.store(generation, Ordering::Release);
                    worker_control
                        .active_window
                        .store(inactive, Ordering::Release);
                    if let Some(sender) = ready_sender.take() {
                        let _ = sender.send(Ok(()));
                    }
                }
                Ok(())
            })();
            if let Err(message) = result
                && let Some(sender) = ready_sender.take()
            {
                let _ = sender.send(Err(message));
            }
        })
        .map_err(|error| audio_error("failed to start clip prefetch worker", error))?;
    match ready_receiver.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok((
            StreamingClip {
                control,
                worker: Some(worker),
                expected_frame: Some(initial_frame),
            },
            target_frames,
        )),
        Ok(Err(message)) => {
            control.shutdown.store(true, Ordering::Release);
            let _ = worker.join();
            Err(audio_error("clip prefetch failed", message))
        }
        Err(error) => {
            control.shutdown.store(true, Ordering::Release);
            let _ = worker.join();
            Err(audio_error("clip prefetch did not become ready", error))
        }
    }
}

fn parse_channel_kind(value: &str) -> Result<ChannelKind> {
    match value {
        "audio" => Ok(ChannelKind::Audio),
        "bus" => Ok(ChannelKind::Bus),
        "master" => Ok(ChannelKind::Master),
        "output" => Ok(ChannelKind::Output),
        _ => Err(invalid_config("unknown mixer channel kind")),
    }
}

fn build_mixer_runtime(
    native: NativeMixerGraph,
    transport: Arc<TransportShared>,
    input_peaks: Arc<InputPeakBank>,
) -> Result<NativeMixerRuntime> {
    if native.sample_rate == 0 {
        return Err(invalid_config("mixer sample rate must be positive"));
    }
    transport
        .sample_rate
        .store(native.sample_rate, Ordering::Relaxed);
    let input_meter_routes = native
        .channels
        .iter()
        .map(|channel| {
            if channel.kind != "audio" || !channel.record_armed {
                return Ok(None);
            }
            let routed = channel
                .input_channels
                .iter()
                .map(|channel| channel.saturating_sub(1) as usize)
                .collect::<Vec<_>>();
            if routed.is_empty()
                || routed.len() > 2
                || routed.iter().any(|&channel| channel >= MAX_INPUT_CHANNELS)
            {
                return Err(invalid_config("armed track has an invalid input mapping"));
            }
            Ok(Some([routed[0], *routed.get(1).unwrap_or(&routed[0])]))
        })
        .collect::<Result<Vec<_>>>()?;
    let channels = native
        .channels
        .iter()
        .map(|channel| {
            Ok(ChannelSpec {
                id: channel.id.clone(),
                kind: parse_channel_kind(&channel.kind)?,
                gain_db: channel.gain_db as f32,
                pan: channel.pan as f32,
                muted: channel.muted,
                soloed: channel.soloed,
                output: channel.output_index.map(|index| index as usize),
                hardware_output: match channel.hardware_output_channels.as_slice() {
                    [] => None,
                    [left, right] if *left > 0 && *right > 0 => {
                        Some([(*left - 1) as usize, (*right - 1) as usize])
                    }
                    _ => return Err(invalid_config("invalid hardware output mapping")),
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let sends = native
        .sends
        .iter()
        .map(|send| {
            Ok(SendSpec {
                id: send.id.clone(),
                source: send.source_index as usize,
                target: send.target_index as usize,
                enabled: send.enabled,
                tap: match send.tap.as_str() {
                    "pre" => SendTap::Pre,
                    "post" => SendTap::Post,
                    _ => return Err(invalid_config("unknown mixer send tap")),
                },
                level_db: send.level_db as f32,
                pan: send.pan as f32,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let audio_track_count = channels
        .iter()
        .filter(|channel| channel.kind == ChannelKind::Audio)
        .count();
    let graph = MixerGraph::new(native.sample_rate, channels, sends)
        .map_err(|error| invalid_config(error.to_string()))?;
    let meter_bank = Arc::new(MeterBank {
        channels: native
            .channels
            .iter()
            .map(|channel| MeterAtomics::new(channel.id.clone()))
            .collect(),
    });
    let mut clips = Vec::with_capacity(native.clips.len());
    let mut content_end_frame = 0_u64;
    for clip in native.clips {
        if clip.track_input_index as usize >= audio_track_count
            || clip.start_frame < 0
            || clip.source_offset_frames < 0
            || clip.length_frames <= 0
        {
            return Err(invalid_config("mixer clip has invalid placement"));
        }
        let start_frame = clip.start_frame as u64;
        let source_offset_frames = clip.source_offset_frames as usize;
        let file_size = fs::metadata(&clip.path)
            .map_err(|error| audio_error("failed to inspect mixer clip cache", error))?
            .len();
        let (samples, sample_frames) = match clip_storage_policy(file_size) {
            ClipStoragePolicy::Memory => {
                let decoded = decode_clip_audio(&clip.path, native.sample_rate)?;
                let sample_frames = decoded.len();
                (ClipSamples::Memory(decoded), sample_frames)
            }
            ClipStoragePolicy::Streaming => {
                let (streaming, sample_frames) =
                    spawn_streaming_clip(clip.path, native.sample_rate, source_offset_frames)?;
                (ClipSamples::Streaming(streaming), sample_frames)
            }
        };
        let available = sample_frames.saturating_sub(source_offset_frames);
        let length_frames = (clip.length_frames as usize).min(available);
        content_end_frame = content_end_frame.max(start_frame.saturating_add(length_frames as u64));
        clips.push(LoadedClip {
            track_input_index: clip.track_input_index as usize,
            start_frame,
            source_offset_frames,
            length_frames,
            samples,
        });
    }
    Ok(NativeMixerRuntime {
        peak_scratch: vec![ChannelPeak::default(); graph.channel_count()],
        held_peaks: vec![[0.0, 0.0]; graph.channel_count()],
        held_until: vec![[0, 0]; graph.channel_count()],
        audio_inputs: vec![[0.0, 0.0]; audio_track_count],
        graph,
        clips,
        meter_bank,
        transport,
        sample_rate: native.sample_rate,
        content_end_frame,
        input_peaks,
        input_meter_routes,
        input_peak_scratch: [0.0; MAX_INPUT_CHANNELS],
        meter_frame_clock: 0,
    })
}

impl NativeMixerRuntime {
    fn handle_command(&mut self, command: EngineCommand) -> Option<Box<NativeMixerRuntime>> {
        match command {
            EngineCommand::LoadMixer(runtime) => return Some(runtime),
            EngineCommand::Preview(preview) => {
                let result = match preview.parameter {
                    RealtimeParameter::ChannelGain => self
                        .graph
                        .channel_index(preview.id())
                        .and_then(|index| self.graph.set_channel_gain(index, preview.value).ok()),
                    RealtimeParameter::ChannelPan => self
                        .graph
                        .channel_index(preview.id())
                        .and_then(|index| self.graph.set_channel_pan(index, preview.value).ok()),
                    RealtimeParameter::SendLevel => self
                        .graph
                        .send_index(preview.id())
                        .and_then(|index| self.graph.set_send_level(index, preview.value).ok()),
                    RealtimeParameter::SendPan => self
                        .graph
                        .send_index(preview.id())
                        .and_then(|index| self.graph.set_send_pan(index, preview.value).ok()),
                };
                let _ = result;
            }
            EngineCommand::Transport(action, position) => match action {
                TransportAction::Play => self
                    .transport
                    .state
                    .store(TRANSPORT_PLAYING, Ordering::Relaxed),
                TransportAction::Pause => self
                    .transport
                    .state
                    .store(TRANSPORT_STOPPED, Ordering::Relaxed),
                TransportAction::Stop => {
                    self.transport
                        .state
                        .store(TRANSPORT_STOPPED, Ordering::Relaxed);
                    self.transport.position_frames.store(0, Ordering::Relaxed);
                }
                TransportAction::Seek => self
                    .transport
                    .position_frames
                    .store(position, Ordering::Relaxed),
                TransportAction::Record => self
                    .transport
                    .state
                    .store(TRANSPORT_RECORDING, Ordering::Relaxed),
            },
            EngineCommand::ClearMeterClips => {
                self.held_peaks.fill([0.0, 0.0]);
                self.held_until.fill([0, 0]);
                for meter in &self.meter_bank.channels {
                    meter.clear_clip();
                }
            }
        }
        None
    }

    fn render_frame(&mut self) -> (HardwareOutputFrame, bool) {
        let state = self.transport.state.load(Ordering::Relaxed);
        if state == TRANSPORT_STOPPED {
            return ([0.0; MAX_OUTPUT_CHANNELS], false);
        }
        let position = self.transport.position_frames.load(Ordering::Relaxed);
        self.audio_inputs.fill([0.0, 0.0]);
        let mut stream_underrun = false;
        for clip in &mut self.clips {
            let Some(relative) = position.checked_sub(clip.start_frame) else {
                continue;
            };
            let relative = relative as usize;
            if relative >= clip.length_frames {
                continue;
            }
            let is_streaming = matches!(&clip.samples, ClipSamples::Streaming(_));
            if let Some(sample) = clip.sample_at(relative) {
                let target = &mut self.audio_inputs[clip.track_input_index];
                target[0] += sample[0];
                target[1] += sample[1];
            } else if is_streaming {
                stream_underrun = true;
            }
        }
        let result = self.graph.process_frame(&self.audio_inputs);
        let next = position.saturating_add(1);
        self.transport
            .position_frames
            .store(next, Ordering::Relaxed);
        if state == TRANSPORT_PLAYING
            && self.content_end_frame > 0
            && next >= self.content_end_frame
        {
            self.transport
                .state
                .store(TRANSPORT_STOPPED, Ordering::Relaxed);
        }
        (result, stream_underrun)
    }

    fn publish_peaks(&mut self, elapsed_frames: usize) {
        self.graph.write_peaks(&mut self.peak_scratch);
        self.input_peaks.take_all(&mut self.input_peak_scratch);
        for (index, route) in self.input_meter_routes.iter().enumerate() {
            if let Some([left, right]) = route {
                let input = [
                    self.input_peak_scratch[*left],
                    self.input_peak_scratch[*right],
                ];
                self.peak_scratch[index].pre = input;
                self.peak_scratch[index].post = input;
            }
        }
        self.meter_frame_clock = self.meter_frame_clock.saturating_add(elapsed_frames as u64);
        let position = self.meter_frame_clock;
        let hold_frames = u64::from(self.sample_rate) * 3 / 2;
        for (index, peak) in self.peak_scratch.iter().copied().enumerate() {
            for side in 0..2 {
                if peak.post[side] >= self.held_peaks[index][side]
                    || position >= self.held_until[index][side]
                {
                    self.held_peaks[index][side] = peak.post[side];
                    self.held_until[index][side] = position.saturating_add(hold_frames);
                }
            }
            if let Some(meter) = self.meter_bank.channels.get(index) {
                meter.store(peak, self.held_peaks[index]);
            }
        }
    }
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
    input_peaks: Arc<InputPeakBank>,
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
                    let mut capture = [0.0_f32; MAX_INPUT_CHANNELS];
                    let capture_channels = channels.min(MAX_INPUT_CHANNELS);
                    for (target, source) in capture[..capture_channels].iter_mut().zip(frame) {
                        *target = f32::from_sample(*source);
                    }
                    input_peaks.observe(&capture[..capture_channels]);
                    recording_tap.push(&capture[..capture_channels]);
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
    mixer_control: OutputMixerControl,
) -> Result<Stream>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let OutputMixerControl {
        mut commands,
        mut mixer,
        mut retired_mixers,
    } = mixer_control;
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

                while let Some(command) = commands.try_pop() {
                    if let Some(runtime) = mixer.as_mut() {
                        if let Some(replacement) = runtime.handle_command(command)
                            && let Some(retired) = mixer.replace(replacement)
                            && let Err(retired) = retired_mixers.try_push(retired)
                        {
                            // Graph retirement should never block the audio callback. A saturated
                            // queue means the control thread has stopped polling; leaking is safer
                            // than deallocating an arbitrarily large graph on the real-time thread.
                            std::mem::forget(retired);
                        }
                    } else if let EngineCommand::LoadMixer(runtime) = command {
                        mixer = Some(runtime);
                    }
                }

                let mut underrun = false;
                let ratio = resampler.adaptive_ratio();
                for frame in data.chunks_exact_mut(channels) {
                    let input = resampler.next_frame(ratio).unwrap_or_else(|| {
                        underrun = true;
                        [0.0, 0.0]
                    });
                    let (rendered, stream_underrun) = mixer
                        .as_mut()
                        .map_or(([0.0; MAX_OUTPUT_CHANNELS], false), |runtime| {
                            runtime.render_frame()
                        });
                    underrun |= stream_underrun;
                    for (channel, sample) in frame.iter_mut().enumerate() {
                        // Input monitoring remains intentionally muted. The bridge is consumed
                        // to keep capture clocks synchronized while the mixer renders project audio.
                        let _input_sample = match channel {
                            0 => input[0],
                            1 => input[1],
                            _ => 0.0,
                        };
                        let value = rendered
                            .get(channel)
                            .copied()
                            .unwrap_or(0.0)
                            .clamp(-1.0, 1.0);
                        *sample = T::from_sample(value);
                    }
                }
                if let Some(runtime) = mixer.as_mut() {
                    runtime.publish_peaks(data.len() / channels);
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
    let (recorder, recording_tap) =
        RecorderController::new(input_config.sample_rate, usize::from(input_config.channels));
    let initial_mixer = pending_mixer_slot()
        .lock()
        .map_err(|_| audio_error("pending mixer lock", "poisoned"))?
        .take();
    let transport = initial_mixer.as_ref().map_or_else(
        || {
            Arc::new(TransportShared {
                state: AtomicU32::new(TRANSPORT_STOPPED),
                position_frames: AtomicU64::new(0),
                sample_rate: AtomicU32::new(output_config.sample_rate),
            })
        },
        |runtime| Arc::clone(&runtime.transport),
    );
    let meter_bank = initial_mixer.as_ref().map_or_else(
        || Arc::new(MeterBank { channels: vec![] }),
        |runtime| Arc::clone(&runtime.meter_bank),
    );
    let input_peaks = initial_mixer.as_ref().map_or_else(
        || Arc::new(InputPeakBank::new()),
        |runtime| Arc::clone(&runtime.input_peaks),
    );
    let command_ring = HeapRb::<EngineCommand>::new(ENGINE_COMMAND_CAPACITY);
    let (commands, command_consumer) = command_ring.split();
    let retirement_ring = HeapRb::<Box<NativeMixerRuntime>>::new(ENGINE_COMMAND_CAPACITY);
    let (retirement_producer, retired_mixers) = retirement_ring.split();

    let input_stream = build_stream_for_format!(
        build_input_stream,
        input_supported.sample_format(),
        &input_device,
        &input_config,
        producer,
        Arc::clone(&metrics),
        recording_tap,
        Arc::clone(&input_peaks),
    )?;
    let output_stream = build_stream_for_format!(
        build_output_stream,
        output_supported.sample_format(),
        &output_device,
        &output_config,
        consumer,
        bridge_block_size as usize,
        Arc::clone(&metrics),
        OutputMixerControl {
            commands: command_consumer,
            mixer: initial_mixer,
            retired_mixers: retirement_producer,
        },
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
        commands,
        retired_mixers,
        meter_bank,
        transport,
        input_peaks,
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
pub fn load_mixer_graph(graph: NativeMixerGraph) -> Result<()> {
    let (transport, input_peaks) = {
        let guard = engine_slot()
            .lock()
            .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
        guard.as_ref().map_or_else(
            || {
                (
                    Arc::new(TransportShared {
                        state: AtomicU32::new(TRANSPORT_STOPPED),
                        position_frames: AtomicU64::new(0),
                        sample_rate: AtomicU32::new(graph.sample_rate),
                    }),
                    Arc::new(InputPeakBank::new()),
                )
            },
            |engine| {
                (
                    Arc::clone(&engine.transport),
                    Arc::clone(&engine.input_peaks),
                )
            },
        )
    };
    let runtime = Box::new(build_mixer_runtime(graph, transport, input_peaks)?);
    let mut guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    if let Some(engine) = guard.as_mut() {
        engine.reclaim_retired_mixers();
        engine.meter_bank = Arc::clone(&runtime.meter_bank);
        engine
            .commands
            .try_push(EngineCommand::LoadMixer(runtime))
            .map_err(|_| audio_error("mixer control queue", "full"))?;
    } else {
        *pending_mixer_slot()
            .lock()
            .map_err(|_| audio_error("pending mixer lock", "poisoned"))? = Some(runtime);
    }
    Ok(())
}

#[napi]
pub fn preview_mixer_parameter(preview: NativeMixerParameterPreview) -> Result<()> {
    let mut guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let Some(engine) = guard.as_mut() else {
        return Ok(());
    };
    engine
        .commands
        .try_push(EngineCommand::Preview(
            RealtimeParameterCommand::from_preview(preview)?,
        ))
        .map_err(|_| audio_error("mixer control queue", "full"))
}

#[napi]
pub fn mixer_snapshot() -> Result<NativeMixerSnapshot> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    Ok(NativeMixerSnapshot {
        meters: guard.as_ref().map_or_else(Vec::new, |engine| {
            engine
                .meter_bank
                .channels
                .iter()
                .map(MeterAtomics::snapshot)
                .collect()
        }),
    })
}

#[napi]
pub fn transport_command(
    kind: String,
    position_frames: Option<i64>,
) -> Result<NativeTransportSnapshot> {
    let mut guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_mut()
        .ok_or_else(|| invalid_config("audio engine must be running before transport"))?;
    let position = position_frames.unwrap_or(0).max(0) as u64;
    let command = match kind.as_str() {
        "clear-meter-clips" => EngineCommand::ClearMeterClips,
        "play" => EngineCommand::Transport(TransportAction::Play, position),
        "pause" => EngineCommand::Transport(TransportAction::Pause, position),
        "stop" => EngineCommand::Transport(TransportAction::Stop, position),
        "seek" => EngineCommand::Transport(TransportAction::Seek, position),
        "record" => EngineCommand::Transport(TransportAction::Record, position),
        _ => return Err(invalid_config("unknown transport command")),
    };
    engine
        .commands
        .try_push(command)
        .map_err(|_| audio_error("mixer control queue", "full"))?;
    Ok(engine.transport.snapshot())
}

#[napi]
pub fn transport_snapshot() -> Result<NativeTransportSnapshot> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    Ok(guard.as_ref().map_or(
        NativeTransportSnapshot {
            state: "stopped".to_owned(),
            position_frames: 0,
            sample_rate: 0,
        },
        |engine| engine.transport.snapshot(),
    ))
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

#[napi]
pub fn recording_waveform_snapshot(
    start_frame: i64,
    end_frame: i64,
    max_buckets: u32,
) -> Result<NativeWaveformSnapshot> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("audio engine is not running"))?;
    engine
        .recorder
        .waveform_snapshot(start_frame, end_frame, max_buckets)
}

#[cfg(feature = "bench-internals")]
#[doc(hidden)]
pub mod bench_support {
    use std::{hint::black_box, sync::Arc, thread};

    use ringbuf::{
        HeapCons, HeapProd, HeapRb,
        traits::{Consumer, Producer, Split},
    };
    use yadaw_dsp_core::mixer::{ChannelKind, ChannelPeak, ChannelSpec, MixerGraph, StereoFrame};

    use super::{
        AdaptiveResampler, ClipSamples, EngineCommand, InputPeakBank, LoadedClip, MeterAtomics,
        MeterBank, NativeMixerRuntime, RealtimeParameter, RealtimeParameterCommand, StreamingClip,
        TRANSPORT_PLAYING, TransportShared, decode_clip_audio, spawn_streaming_clip,
    };

    #[derive(Clone, Copy, Debug)]
    pub struct RenderScenario {
        pub sample_rate: u32,
        pub tracks: usize,
        pub total_clips: usize,
        pub active_clips: usize,
        pub clip_frames: usize,
    }

    fn runtime_for(scenario: RenderScenario) -> Box<NativeMixerRuntime> {
        assert!(scenario.sample_rate > 0);
        assert!(scenario.tracks > 0);
        assert!(scenario.active_clips <= scenario.total_clips);
        let master = scenario.tracks;
        let output = master + 1;
        let mut channels = Vec::with_capacity(master + 2);
        for index in 0..scenario.tracks {
            channels.push(ChannelSpec {
                id: format!("audio-{index}"),
                kind: ChannelKind::Audio,
                gain_db: -3.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output: Some(output),
                hardware_output: None,
            });
        }
        channels.push(ChannelSpec {
            id: "master".to_owned(),
            kind: ChannelKind::Master,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: None,
            hardware_output: None,
        });
        channels.push(ChannelSpec {
            id: "output".to_owned(),
            kind: ChannelKind::Output,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: None,
            hardware_output: Some([0, 1]),
        });
        let graph = MixerGraph::new(scenario.sample_rate, channels, Vec::new())
            .expect("benchmark graph must be valid");
        let meter_bank = Arc::new(MeterBank {
            channels: (0..scenario.tracks + 2)
                .map(|index| MeterAtomics::new(format!("channel-{index}")))
                .collect(),
        });
        let transport = Arc::new(TransportShared {
            state: super::AtomicU32::new(TRANSPORT_PLAYING),
            position_frames: super::AtomicU64::new(0),
            sample_rate: super::AtomicU32::new(scenario.sample_rate),
        });
        let input_peaks = Arc::new(InputPeakBank::new());
        let clip_frames = scenario.clip_frames.max(1);
        let clips = (0..scenario.total_clips)
            .map(|index| {
                let active = index < scenario.active_clips;
                LoadedClip {
                    track_input_index: index % scenario.tracks,
                    start_frame: if active {
                        0
                    } else {
                        1_000_000_u64.saturating_add(index as u64)
                    },
                    source_offset_frames: 0,
                    length_frames: if active { clip_frames } else { 1 },
                    samples: ClipSamples::Memory(if active {
                        vec![[0.03125, -0.015625]; clip_frames]
                    } else {
                        vec![[0.0, 0.0]]
                    }),
                }
            })
            .collect();
        Box::new(NativeMixerRuntime {
            peak_scratch: vec![ChannelPeak::default(); graph.channel_count()],
            held_peaks: vec![[0.0, 0.0]; graph.channel_count()],
            held_until: vec![[0, 0]; graph.channel_count()],
            audio_inputs: vec![[0.0, 0.0]; scenario.tracks],
            graph,
            clips,
            meter_bank,
            transport,
            sample_rate: scenario.sample_rate,
            content_end_frame: u64::MAX,
            input_peaks,
            input_meter_routes: vec![None; scenario.tracks + 2],
            input_peak_scratch: [0.0; super::MAX_INPUT_CHANNELS],
            meter_frame_clock: 0,
        })
    }

    pub struct RenderHarness {
        runtime: Box<NativeMixerRuntime>,
    }

    impl RenderHarness {
        pub fn new(scenario: RenderScenario) -> Self {
            Self {
                runtime: runtime_for(scenario),
            }
        }

        pub fn render_block(&mut self, frames: usize) -> StereoFrame {
            self.runtime
                .transport
                .position_frames
                .store(0, super::Ordering::Relaxed);
            let mut output = [0.0, 0.0];
            for _ in 0..frames {
                let (frame, underrun) = self.runtime.render_frame();
                debug_assert!(!underrun);
                output = [frame[0], frame[1]];
            }
            output
        }

        pub fn publish_meters(&mut self, elapsed_frames: usize) {
            self.runtime.publish_peaks(elapsed_frames);
        }
    }

    pub struct ParameterQueueHarness {
        runtime: Box<NativeMixerRuntime>,
        producer: HeapProd<EngineCommand>,
        consumer: HeapCons<EngineCommand>,
        command: RealtimeParameterCommand,
    }

    impl ParameterQueueHarness {
        pub fn new() -> Self {
            let ring = HeapRb::<EngineCommand>::new(8);
            let (producer, consumer) = ring.split();
            let mut id = [0_u8; 64];
            id[..7].copy_from_slice(b"audio-0");
            Self {
                runtime: runtime_for(RenderScenario {
                    sample_rate: 48_000,
                    tracks: 32,
                    total_clips: 32,
                    active_clips: 32,
                    clip_frames: 1_024,
                }),
                producer,
                consumer,
                command: RealtimeParameterCommand {
                    id,
                    id_len: 7,
                    parameter: RealtimeParameter::ChannelGain,
                    value: -6.0,
                },
            }
        }

        pub fn consume_preview(&mut self, value: f32) {
            self.command.value = value;
            assert!(
                self.producer
                    .try_push(EngineCommand::Preview(self.command))
                    .is_ok(),
                "benchmark control ring must have capacity"
            );
            let command = self
                .consumer
                .try_pop()
                .expect("benchmark command must be available");
            black_box(self.runtime.handle_command(command));
        }
    }

    impl Default for ParameterQueueHarness {
        fn default() -> Self {
            Self::new()
        }
    }

    pub struct GraphSwapHarness {
        current: Option<Box<NativeMixerRuntime>>,
        replacement: Option<Box<NativeMixerRuntime>>,
    }

    impl GraphSwapHarness {
        pub fn new(scenario: RenderScenario) -> Self {
            Self {
                current: Some(runtime_for(scenario)),
                replacement: Some(runtime_for(scenario)),
            }
        }

        pub fn swap_at_block_boundary(&mut self) {
            let mut current = self.current.take().expect("current graph");
            let replacement = self.replacement.take().expect("replacement graph");
            let incoming = current
                .handle_command(EngineCommand::LoadMixer(replacement))
                .expect("load command returns replacement");
            self.current = Some(incoming);
            self.replacement = Some(current);
        }
    }

    pub struct ResamplerHarness {
        resampler: AdaptiveResampler,
        output_frames: usize,
    }

    impl ResamplerHarness {
        pub fn new(input_rate: u32, output_rate: u32, output_frames: usize) -> Self {
            let source_frames = (output_frames as u128 * u128::from(input_rate))
                .div_ceil(u128::from(output_rate)) as usize
                + 4;
            let capacity = source_frames.next_power_of_two().max(8);
            let ring = HeapRb::<StereoFrame>::new(capacity);
            let (mut producer, consumer) = ring.split();
            for index in 0..source_frames {
                producer
                    .try_push([
                        index as f32 / source_frames as f32,
                        -(index as f32 / source_frames as f32),
                    ])
                    .expect("resampler fixture ring has capacity");
            }
            Self {
                resampler: AdaptiveResampler::new(
                    consumer,
                    input_rate,
                    output_rate,
                    source_frames / 2,
                    capacity,
                ),
                output_frames,
            }
        }

        pub fn render(&mut self) -> StereoFrame {
            let mut output = [0.0, 0.0];
            for _ in 0..self.output_frames {
                let ratio = self.resampler.adaptive_ratio();
                output = self.resampler.next_frame(ratio).unwrap_or_default();
            }
            output
        }
    }

    pub fn decode_clip(path: &str, target_sample_rate: u32) -> usize {
        decode_clip_audio(path, target_sample_rate)
            .expect("benchmark fixture must decode")
            .len()
    }

    pub struct StreamingHarness {
        clip: StreamingClip,
        block_frames: usize,
    }

    impl StreamingHarness {
        pub fn open(path: impl Into<String>, target_sample_rate: u32, block_frames: usize) -> Self {
            let (clip, _) =
                spawn_streaming_clip(path.into(), target_sample_rate, 0).expect("stream fixture");
            Self { clip, block_frames }
        }

        pub fn read_cached_block(&mut self) -> StereoFrame {
            self.clip.expected_frame = Some(0);
            let mut output = [0.0, 0.0];
            for frame in 0..self.block_frames {
                output = self
                    .clip
                    .sample_at(frame)
                    .expect("initial window is cached");
            }
            output
        }

        pub fn seek_and_refill(&mut self, frame: usize) -> StereoFrame {
            self.clip.expected_frame = None;
            loop {
                if let Some(sample) = self.clip.sample_at(frame) {
                    return sample;
                }
                self.clip.expected_frame = Some(frame);
                thread::yield_now();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs, thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use super::{
        AdaptiveResampler, BufferSelection, BufferSize, ClipStoragePolicy, InputPeakBank,
        MAX_INPUT_CHANNELS, MEMORY_DECODE_LIMIT_BYTES, SupportedBufferSize, clip_storage_policy,
        select_buffer_size, spawn_streaming_clip,
    };
    use crate::recording::{NativeRecordingStartConfig, write_deterministic_test_recording};
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
    fn streams_only_assets_above_the_memory_decode_limit() {
        assert_eq!(
            clip_storage_policy(MEMORY_DECODE_LIMIT_BYTES),
            ClipStoragePolicy::Memory
        );
        assert_eq!(
            clip_storage_policy(MEMORY_DECODE_LIMIT_BYTES + 1),
            ClipStoragePolicy::Streaming
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

    #[test]
    fn captures_multichannel_input_peaks_and_resets_the_snapshot() {
        let peaks = InputPeakBank::new();
        peaks.observe(&[0.25, -0.75, 1.25]);
        peaks.observe(&[-0.5, 0.5, 0.25]);
        let mut snapshot = [0.0; MAX_INPUT_CHANNELS];
        peaks.take_all(&mut snapshot);
        assert_eq!(&snapshot[..3], &[0.5, 0.75, 1.25]);
        peaks.take_all(&mut snapshot);
        assert_eq!(&snapshot[..3], &[0.0, 0.0, 0.0]);
    }

    #[test]
    fn streaming_clip_prefetches_and_restarts_after_a_seek_generation() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "yadaw-streaming-{}-{nonce}.bwf",
            std::process::id()
        ));
        write_deterministic_test_recording(
            NativeRecordingStartConfig {
                path: path.to_string_lossy().into_owned(),
                asset_id: "streaming-test".to_owned(),
                originator: "YADAW test".to_owned(),
                origination_date: "2026-07-24".to_owned(),
                origination_time: "12:00:00".to_owned(),
                time_reference: 0,
            },
            48_000,
            4_800,
        )
        .unwrap();
        let (mut stream, frames) =
            spawn_streaming_clip(path.to_string_lossy().into_owned(), 48_000, 0).unwrap();
        assert_eq!(frames, 4_800);
        assert!(stream.sample_at(0).is_some());

        let mut refilled = false;
        for frame in 1_234..1_334 {
            if stream.sample_at(frame).is_some() {
                refilled = true;
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(refilled);
        drop(stream);
        fs::remove_file(path).unwrap();
    }
}
