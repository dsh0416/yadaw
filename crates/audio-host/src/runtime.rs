#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::panic_in_result_fn,
        clippy::unwrap_used
    )
)]
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
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
    time::{Duration, Instant},
};

use crate::{
    crash_marker, device,
    editor_platform::{self, NativeUiContext},
    editor_window::{
        EditorAction, EditorClipboard, EditorMenuAction, EditorMenuWindow, EditorWindow,
        toolbar_menu_window_attributes,
    },
    engine,
    midi_input::MidiInputActor,
    recording::{NativeRecordingResult, NativeRecordingStartConfig, NativeWaveformSnapshot},
    vst3,
    workers::WorkerSupervisor,
};
use heron_dsp_runtime::protocol::{
    AudioBackend, AudioDevice, AudioDeviceList, AudioRuntime, BinaryPayload, ControlCommand,
    ControlRequest, ControlResponse, ControlResult, GraphCandidateSnapshot,
    GraphDeploymentSnapshot, GraphDeploymentStatus, GraphOperationOutcome, GraphOperationSnapshot,
    GraphTransactionRequest, GraphTransactionValue, GraphUpdate, HostEvent, IPC_PROTOCOL_VERSION,
    LiveLatencyPolicy, LiveMixerGraph, MixerChannelMeter, PluginEditorContext,
    PluginEditorPreference, PriorityCommand, PriorityRequest, PriorityResponse, PriorityResult,
    RecordingResult, RecordingWaveform, ResourceKind, ResourceRef, RoundTripLatencyMeasurement,
    RpcError, RpcErrorCategory, RpcErrorCode, RpcErrorDetails, RpcFailure, RpcMutationOutcome,
    RpcRequestMeta, RpcResult, RpcRetry, RpcSuccess, TransportState, read_message, write_message,
};
use heron_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};
use heron_ipc_transport::{
    ArenaReceiver, HostBootstrap, INITIAL_TELEMETRY_CAPACITY, LeaseRegistry, MappingCommand,
    MappingEvent, MappingFailure, MidiNoteBatchView, ParameterConsumer, ResolvedBlob,
    SharedMemoryDescriptor, SharedMemoryError, TelemetryMeter, TelemetrySnapshot, TelemetryWriter,
    TransportError, WirePacket, create_parameter_ring, create_telemetry_page, decode_body,
    decode_request_deferred, encode_event, encode_priority, encode_response_from_arena,
    materialize_mixer_graph, resolve_midi_note_batch,
};
use heron_vst3_host::Vst3HostRequest;
use iced_wgpu::window::Compositor as WgpuCompositor;
use ipc_channel::{
    TryRecvError,
    ipc::{self, IpcSender},
};
use tokio::{
    sync::{Semaphore, mpsc, oneshot, watch},
    task::JoinSet,
};
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
    window::{WindowAttributes, WindowId},
};

mod bootstrap;
mod egress;
mod engine_actor;
mod graph_transactions;
mod ingress;
mod plugin_actor;
mod protocol_actor;
mod runtime_config;
mod telemetry;
mod ui_runtime;
mod wire_adapters;

use bootstrap::run_ipc;
use egress::{
    EgressArenas, EgressMetrics, InboundRequest, OutboundMessage, PriorityIngress, response,
    run_egress,
};
use engine_actor::{
    ActorCommand, ActorRequest, GraphParameterHandles, background_io_actor, dispatch_build_graph,
    engine_actor, forward_to_ui, publish_built_graph, queue_background_graph_build,
    refresh_graph_handles, stable_runtime_handle,
};
use graph_transactions::{
    GraphTransactionState, PreparedGraphCandidate, graph_busy_error, graph_conflict_error,
    graph_correlation, graph_dependency_error, graph_failure, graph_stale_error, graph_success,
    graph_timeout_error, graph_validation_error, validate_graph_meta, validate_graph_request,
    wait_for_graph_publication,
};
use ingress::{IngressChannels, IngressMailboxes, Liveness, spawn_ingress};
use plugin_actor::{
    Vst3ActorDeps, dispatch_actor, dispatch_parameter, is_background_io_command, is_vst3_command,
    protocol_deadline, vst3_actor,
};
use protocol_actor::{ProtocolActorDeps, run_protocol_actor};
use runtime_config::RuntimeConfig;
use telemetry::{TelemetryPages, publish_telemetry};
use ui_runtime::{UiEvent, WinitHost, parse_editor_owner_window};
use wire_adapters::{engine_command, live_graph, run_legacy};

static MIDI_INPUT: OnceLock<MidiInputActor> = OnceLock::new();

pub fn run() -> ExitCode {
    let _ = MIDI_INPUT.set(MidiInputActor::start(
        heron_dsp_runtime::protocol::MidiSyncPreferences {
            enabled: false,
            source_port_id: None,
            source_port_name: None,
            input_offsets_ms: BTreeMap::new(),
            control_port_ids: BTreeSet::new(),
            capture_all_controls: false,
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

#[cfg(test)]
#[allow(clippy::wildcard_imports)]
mod tests;
