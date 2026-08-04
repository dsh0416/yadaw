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
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc as std_mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use crate::{
    device,
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
    ControlResult, GraphCandidateSnapshot, GraphDeploymentSnapshot, GraphDeploymentStatus,
    GraphOperationOutcome, GraphOperationSnapshot, GraphTransactionRequest, GraphTransactionValue,
    GraphUpdate, HostEvent, IPC_PROTOCOL_VERSION, LiveLatencyPolicy, LiveMixerGraph, MidiNoteBatch,
    MixerChannelMeter, PluginEditorContext, PluginEditorPreference, RecordingResult,
    RecordingWaveform, ResourceKind, ResourceRef, RoundTripLatencyMeasurement, RpcError,
    RpcErrorCategory, RpcErrorCode, RpcErrorDetails, RpcFailure, RpcMutationOutcome,
    RpcRequestMeta, RpcResult, RpcRetry, RpcSuccess, TransportState,
};
use heron_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};
use heron_vst3_host::Vst3HostRequest;
use iced_wgpu::window::Compositor as WgpuCompositor;
use tokio::sync::{mpsc, oneshot};
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoopProxy},
    window::{WindowAttributes, WindowId},
};

pub mod embedded;
mod engine_actor;
mod graph_transactions;
mod plugin_actor;
mod runtime_config;
mod ui_runtime;
mod wire_adapters;

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
use plugin_actor::{
    Vst3ActorDeps, dispatch_actor, dispatch_parameter, is_background_io_command, is_vst3_command,
    slow_request_threshold, vst3_actor,
};
use runtime_config::RuntimeConfig;
use ui_runtime::{UiEvent, WinitHost};
use wire_adapters::{engine_command, live_graph};

static MIDI_INPUT: OnceLock<MidiInputActor> = OnceLock::new();
