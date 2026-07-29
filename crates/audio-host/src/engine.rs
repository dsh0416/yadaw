use std::{
    collections::BTreeMap,
    fs,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use bwavfile::WaveReader;
use cpal::{
    BufferSize, Device, FromSample, Host, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
    SupportedBufferSize, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};
use rubato::{
    Adjustable, Async, FixedAsync, Resampler, SincInterpolationParameters,
    audioadapter_buffers::direct::InterleavedSlice,
};
use yadaw_dsp_core::mixer::{
    ChannelKind, ChannelPeak, ChannelSpec, HardwareOutputFrame, MAX_OUTPUT_CHANNELS, MixerGraph,
    RouteTarget, SendSpec, SendTap,
};
use yadaw_dsp_render::{RenderMeter, RenderRuntime};
use yadaw_dsp_runtime::{
    MUSICAL_TICKS_PER_QUARTER,
    block::{LatencyNode, StereoDelayLine, plan_latency_compensation},
    protocol::{
        CompiledAudioGraphSnapshot, CompiledGraphEdge, CompiledGraphEdgeKind, CompiledGraphNode,
        CompiledGraphNodeKind, CompiledGraphPluginState, CompiledGraphSignalWidth,
        LiveMixerSendTap, LiveMixerSystemRole, PluginAudioMode,
    },
    tempo::{TempoEvent, TempoMap, TimeSignatureEvent},
};

use crate::recording::{
    MAX_INPUT_CHANNELS, NativeRecordingResult, NativeRecordingStartConfig, NativeWaveformSnapshot,
    RecorderController, RecordingTap, StereoFrame,
};
use crate::vst3::{ProcessContext, Vst3ProcessorHandle};
use crate::{HostError as Error, HostResult as Result, Status};

const UNKNOWN_LATENCY_US: u64 = u64::MAX;
const RING_BUFFER_BLOCKS: usize = 8;
static AUDIO_ENGINE: OnceLock<Mutex<Option<AudioEngine>>> = OnceLock::new();
static PENDING_MIXER: OnceLock<Mutex<Option<Box<NativeMixerRuntime>>>> = OnceLock::new();
static LAST_NATIVE_GRAPH: OnceLock<Mutex<Option<NativeMixerGraph>>> = OnceLock::new();
static COMPILED_GRAPH_SNAPSHOTS: OnceLock<Mutex<BTreeMap<u64, CompiledAudioGraphSnapshot>>> =
    OnceLock::new();
static NEXT_BUILD_GENERATION: AtomicU64 = AtomicU64::new(1);
static STREAM_WORKERS: OnceLock<StreamWorkerPool> = OnceLock::new();

const ENGINE_COMMAND_CAPACITY: usize = 256;
const MEMORY_DECODE_LIMIT_BYTES: u64 = 32 * 1024 * 1024;
const STREAM_WINDOW_SECONDS: usize = 2;
const TRANSPORT_STOPPED: u32 = 0;
const TRANSPORT_PLAYING: u32 = 1;
const TRANSPORT_RECORDING: u32 = 2;
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

include!("engine/spec.rs");
include!("engine/metering.rs");
include!("engine/clip_streaming.rs");
include!("engine/transport_midi.rs");
include!("engine/latency_measurement.rs");
include!("engine/lifecycle_types.rs");
include!("engine/clip_decode.rs");
include!("engine/compiled_graph.rs");
include!("engine/graph_build.rs");
include!("engine/render_runtime.rs");
include!("engine/device_streams.rs");
include!("engine/resampling.rs");
include!("engine/lifecycle.rs");
include!("engine/publication.rs");
include!("engine/recording.rs");
include!("engine/bench_support.rs");
include!("engine/tests.rs");
