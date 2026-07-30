use std::{
    collections::{BTreeMap, HashMap},
    env,
    io::{self, BufReader, BufWriter},
    path::PathBuf,
    process::ExitCode,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc as std_mpsc,
    },
    thread,
};

use iced_tiny_skia::window::Compositor as TinySkiaCompositor;
use ipc_channel::ipc::{self, IpcSender};
use tokio::{
    sync::{Semaphore, mpsc, oneshot, watch},
    task::JoinSet,
};
#[cfg(target_os = "macos")]
use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    window::{WindowAttributes, WindowId},
};
use yadaw_audio_host::{
    crash_marker, device,
    editor_platform::{self, NativeUiContext},
    editor_window::{EditorAction, EditorWindow},
    engine,
    midi_input::MidiInputActor,
    recording::{NativeRecordingResult, NativeRecordingStartConfig, NativeWaveformSnapshot},
    vst3,
    workers::WorkerSupervisor,
};
use yadaw_dsp_runtime::protocol::{
    AudioBackend, AudioDevice, AudioDeviceList, AudioRuntime, BinaryPayload, ControlCommand,
    ControlRequest, ControlResponse, ControlResult, GraphUpdate, HostEvent, LiveMixerGraph,
    MixerChannelMeter, NATIVE_BUILD_FINGERPRINT, PluginEditorPreference, PriorityCommand,
    PriorityRequest, PriorityResponse, PriorityResult, RecordingResult, RecordingWaveform,
    RoundTripLatencyMeasurement, TransportState, read_message, write_message,
};
use yadaw_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};
use yadaw_ipc_transport::{
    ArenaReceiver, HostBootstrap, LeaseRegistry, MidiNoteBatchView, ParameterConsumer, RegionOffer,
    ResolvedBlob, TelemetryMeter, TelemetrySnapshot, TelemetryWriter, WirePacket,
    create_telemetry_page, decode_body, decode_request_deferred, encode_event, encode_priority,
    encode_response_from_arena, materialize_mixer_graph, resolve_midi_note_batch,
};

include!("runtime/wire_adapters.rs");
include!("runtime/engine_actor.rs");
include!("runtime/plugin_actor.rs");
include!("runtime/egress.rs");
include!("runtime/ingress.rs");
include!("runtime/telemetry.rs");
include!("runtime/protocol_actor.rs");
include!("runtime/runtime_config.rs");
include!("runtime/ui_runtime.rs");
include!("runtime/bootstrap.rs");

static MIDI_INPUT: OnceLock<MidiInputActor> = OnceLock::new();

fn main() -> ExitCode {
    let _ = MIDI_INPUT.set(MidiInputActor::start(
        yadaw_dsp_runtime::protocol::MidiSyncPreferences {
            enabled: false,
            source_port_id: None,
            source_port_name: None,
            input_offsets_ms: BTreeMap::new(),
        },
    ));
    let uses_ipc = env::args_os().any(|argument| argument == "--ipc-token");
    let result = if uses_ipc { run_ipc() } else { run_legacy() };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("audio-host: {error}");
            ExitCode::FAILURE
        }
    }
}

include!("runtime/tests.rs");
