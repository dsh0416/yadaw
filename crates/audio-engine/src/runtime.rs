use std::{
    collections::BTreeMap,
    fs,
    sync::{
        Arc, Mutex, OnceLock, TryLockError,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use bwavfile::WaveReader;
use cpal::{
    BufferSize, Device, FromSample, Host, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
    SupportedBufferSize, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use heron_dsp_core::mixer::{
    ChannelKind, ChannelPeak, ChannelSpec, HardwareOutputFrame, MAX_OUTPUT_CHANNELS, MixerGraph,
    RouteTarget, SendSpec, SendTap,
};
use heron_dsp_render::{RenderMeter, RenderRuntime};
use heron_dsp_runtime::{
    MUSICAL_TICKS_PER_QUARTER,
    block::{MAX_PLUGIN_BLOCK_FRAMES, StereoDelayLine},
    low_latency::{LowLatencyChannel, LowLatencyPlan, LowLatencyPlugin, plan_low_latency},
    protocol::{
        CompiledAudioGraphSnapshot, CompiledGraphEdge, CompiledGraphEdgeKind, CompiledGraphNode,
        CompiledGraphNodeKind, CompiledGraphPluginState, CompiledGraphSignalWidth,
        LiveMixerSendTap, LiveMixerSystemRole, PluginAudioMode,
    },
    tempo::{TempoEvent, TempoMap, TimeSignatureEvent},
};
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};
use rubato::{
    Adjustable, Async, FixedAsync, Resampler, SincInterpolationParameters,
    audioadapter_buffers::direct::InterleavedSlice,
};

use crate::recording::{
    MAX_INPUT_CHANNELS, NativeRecordingResult, NativeRecordingStartConfig, NativeWaveformSnapshot,
    RecorderController, RecordingTap, StereoFrame,
};
use crate::{HostError as Error, HostResult as Result, Status};
use heron_vst3_host::{HostProcessContext as ProcessContext, Vst3ProcessorHandle};

const UNKNOWN_LATENCY_US: u64 = u64::MAX;
const RING_BUFFER_BLOCKS: usize = 8;
static STREAM_WORKERS: OnceLock<StreamWorkerPool> = OnceLock::new();
#[cfg(any(test, feature = "bench-internals", feature = "test-support"))]
pub static GRAPH_TEST_LOCK: Mutex<()> = Mutex::new(());

const ENGINE_COMMAND_CAPACITY: usize = 256;
const MEMORY_DECODE_LIMIT_BYTES: u64 = 32 * 1024 * 1024;
const STREAM_WINDOW_SECONDS: usize = 2;
const TRANSPORT_STOPPED: u32 = 0;
const TRANSPORT_PLAYING: u32 = 1;
const TRANSPORT_RECORDING: u32 = 2;
const TRANSPORT_WAITING: u32 = 3;
const TRANSPORT_COUNTING_IN: u32 = 4;
const METRONOME_ACCENT_NOTE: u8 = 84;
const METRONOME_BEAT_NOTE: u8 = 72;
const METRONOME_NOTE_ID: i32 = -1;
const METRONOME_NOTE_LENGTH_MS: u64 = 20;
const INPUT_RESAMPLER_OUTPUT_FRAMES: usize = 256;
const OUTPUT_RESAMPLER_FRAMES: usize = 256;
const LOOPBACK_MEASUREMENT_IDLE: u32 = 0;
const LOOPBACK_MEASUREMENT_PREPARING: u32 = 1;
const LOOPBACK_MEASUREMENT_READY: u32 = 2;
const LOOPBACK_MEASUREMENT_RUNNING: u32 = 3;
const LOOPBACK_MEASUREMENT_COMPLETE: u32 = 4;
const LOOPBACK_MEASUREMENT_INPUT_TOO_LOUD: u32 = 5;
const LOOPBACK_MEASUREMENT_SIGNAL_NOT_DETECTED: u32 = 6;
const LOOPBACK_MEASUREMENT_TIMEOUT_NS: u64 = 3_000_000_000;
const LOOPBACK_QUIET_DURATION_MS: u64 = 50;
const LOOPBACK_QUIET_THRESHOLD: f32 = 0.03;
const LOOPBACK_PROBE_AMPLITUDE: f32 = 0.25;
const LOOPBACK_CORRELATION_THRESHOLD: f32 = 0.82;
const LOOPBACK_MINIMUM_SIGNAL_ENERGY: f32 = 0.02;
const LOOPBACK_PROBE: [f32; 13] = [
    1.0, 1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, 1.0,
];
type InputFrame = [f32; MAX_INPUT_CHANNELS];

/// Owned control-plane state for one audio-helper process.
///
/// The host creates exactly one instance and passes an explicit reference to
/// actors that need engine snapshots or mutations. The object is intentionally
/// not `Clone`; real-time callbacks only retain the narrow atomic/ring-buffer
/// endpoints constructed while a stream is running.
pub struct AudioEngine {
    runtime_transition: Mutex<()>,
    running: Mutex<Option<RunningAudioEngine>>,
    pending_mixer: Mutex<Option<Box<NativeMixerRuntime>>>,
    last_native_graph: Mutex<Option<NativeMixerGraph>>,
    compiled_graph_snapshots: Mutex<BTreeMap<u64, CompiledAudioGraphSnapshot>>,
    next_build_generation: AtomicU64,
}

impl AudioEngine {
    #[must_use]
    pub fn new() -> Self {
        Self {
            runtime_transition: Mutex::new(()),
            running: Mutex::new(None),
            pending_mixer: Mutex::new(None),
            last_native_graph: Mutex::new(None),
            compiled_graph_snapshots: Mutex::new(BTreeMap::new()),
            next_build_generation: AtomicU64::new(1),
        }
    }
}

impl Default for AudioEngine {
    fn default() -> Self {
        Self::new()
    }
}

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

#[cfg(feature = "bench-internals")]
#[doc(hidden)]
#[path = "engine/bench_support.rs"]
pub mod bench_support;
#[path = "engine/benchmark.rs"]
mod benchmark;
#[path = "engine/clip_decode.rs"]
mod clip_decode;
#[path = "engine/clip_streaming.rs"]
mod clip_streaming;
#[path = "engine/compiled_graph.rs"]
mod compiled_graph;
#[path = "engine/device_streams.rs"]
mod device_streams;
#[path = "engine/graph_build.rs"]
mod graph_build;
#[path = "engine/latency_measurement.rs"]
mod latency_measurement;
#[path = "engine/lifecycle.rs"]
mod lifecycle;
#[path = "engine/lifecycle_types.rs"]
mod lifecycle_types;
#[path = "engine/metering.rs"]
mod metering;
#[path = "engine/publication.rs"]
mod publication;
#[path = "engine/recording.rs"]
mod recording;
#[path = "engine/render_runtime.rs"]
mod render_runtime;
#[path = "engine/resampling.rs"]
mod resampling;
#[path = "engine/spec.rs"]
mod spec;
#[path = "engine/transport_midi.rs"]
mod transport_midi;

use clip_decode::{parse_channel_kind, spawn_streaming_clip};
use clip_streaming::{ClipSamples, LoadedClip, StreamTask, StreamWorkerPool, StreamingClip};
use compiled_graph::compiled_graph_snapshot;
use device_streams::{
    StreamDirection, duration_to_micros, find_device, frames_to_micros, frames_to_ms,
    frames_to_nanos, mark_stream_error, optional_latency, resolve_stream_devices, stream_config,
};
use graph_build::build_mixer_runtime;
use latency_measurement::{
    EngineCommand, NativeMixerRuntime, RealtimeParameter, RealtimeParameterCommand,
    RoundTripInputDetector, RoundTripLatencyMeasurement, RoundTripOutputProbe, RuntimeMetrics,
    TransportAction,
};
use lifecycle_types::{
    AudioEngineKey, OutputMixerControl, OutputStreamContext, RunningAudioEngine, audio_error,
    invalid_config, take_pending_mixer,
};
use metering::{InputPeakBank, MeterAtomics, MeterBank, StreamControl, TransportShared};
use resampling::{build_input_stream, build_output_stream, build_stream_for_format};
use spec::plan_native_low_latency;
use transport_midi::{
    BlockMidiEvent, CountInState, LiveMidiRoute, LivePlugin, LivePluginAuxInput,
    MetronomeScheduler, ScheduledMidiEvent, ScheduledMidiEventKind, SignalWidth,
};

pub use benchmark::run_audio_benchmark;
pub use clip_decode::decode_clip_audio;
pub use metering::TransportClockHandle;
pub use publication::{CompiledGraphBuild, GraphBuildInput, PublishOutcome, compile_graph_build};
pub use spec::{
    NativeAudioEngineConfig, NativeAudioRuntimeSnapshot, NativeLatencyPolicy, NativeMidiClip,
    NativeMidiEvent, NativeMidiEventKind, NativeMidiNote, NativeMixerChannel,
    NativeMixerChannelMeter, NativeMixerClip, NativeMixerGraph, NativeMixerParameterPreview,
    NativeMixerSend, NativeMixerSnapshot, NativePluginAuxInputBus, NativePluginInstance,
    NativeRoundTripLatencyMeasurementRequest, NativeRoundTripLatencyMeasurementSnapshot,
    NativeTransportSnapshot,
};

#[cfg(test)]
#[allow(clippy::wildcard_imports)]
#[path = "engine/tests.rs"]
mod tests;
