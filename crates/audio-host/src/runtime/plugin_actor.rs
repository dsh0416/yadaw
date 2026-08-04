use super::{
    ActorCommand, ActorRequest, Arc, BinaryPayload, ControlCommand, ControlResult,
    GraphParameterHandles, GraphTransactionRequest, GraphTransactionState, GraphTransactionValue,
    GraphUpdate, HashMap, LiveMixerGraph, MIDI_INPUT, Mutex, PreparedGraphCandidate,
    RpcRequestMeta, UiMailboxWaker, dispatch_build_graph, engine, forward_to_ui, graph_busy_error,
    graph_conflict_error, graph_correlation, graph_dependency_error, graph_failure,
    graph_stale_error, graph_success, graph_timeout_error, graph_validation_error, live_graph,
    mpsc, oneshot, publish_built_graph, refresh_graph_handles, std_mpsc, validate_graph_meta,
    validate_graph_request, vst3, wait_for_graph_publication,
};

pub(super) struct Vst3ActorDeps {
    pub(super) ui_proxy: UiMailboxWaker,
    pub(super) ui_sender: std_mpsc::SyncSender<ActorRequest>,
    pub(super) processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    pub(super) handles: Arc<Mutex<GraphParameterHandles>>,
    pub(super) background_sender: mpsc::Sender<ActorRequest>,
    pub(super) engine_sender: mpsc::Sender<ActorRequest>,
    pub(super) audio_engine: Arc<engine::AudioEngine>,
    pub(super) session_epoch: u64,
}

#[path = "plugin_actor/command_dispatch.rs"]
mod command_dispatch;
#[path = "plugin_actor/graph_deployment.rs"]
mod graph_deployment;
#[path = "plugin_actor/loading.rs"]
mod loading;
#[path = "plugin_actor/request_policy.rs"]
mod request_policy;

pub(super) use command_dispatch::{dispatch_actor, dispatch_parameter, vst3_actor};
pub(super) use request_policy::{
    is_background_io_command, is_vst3_command, slow_request_threshold,
};
