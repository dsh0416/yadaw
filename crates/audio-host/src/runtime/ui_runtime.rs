use self::embedded_editors::EmbeddedEditorHost;
use super::{
    ActiveEventLoop, ActorCommand, ActorRequest, ApplicationHandler, Arc, AtomicU64,
    ControlCommand, ControlFlow, ControlResult, Duration, EditorAction, EditorClipboard,
    EditorMenuAction, EditorMenuWindow, EditorWindow, HashMap, HostEvent, Instant, LiveMixerGraph,
    LogicalSize, Mutex, Ordering, PluginEditorContext, PluginEditorPreference, VecDeque,
    Vst3HostRequest, WgpuCompositor, WindowAttributes, WindowEvent, WindowId, editor_platform,
    engine, mpsc, queue_background_graph_build, std_mpsc, toolbar_menu_window_attributes, vst3,
};

#[derive(Debug, Clone)]
pub struct EmbeddedEditorHostRegistration {
    pub instance_id: String,
    pub parent_window: usize,
    pub width: u32,
    pub height: u32,
    pub top_inset: u32,
    pub display_scale: f64,
}

#[derive(Debug, Clone)]
pub struct EmbeddedEditorHostSnapshot {
    pub instance_id: String,
    pub width: u32,
    pub height: u32,
    pub display_scale: f64,
    pub resizable: bool,
    pub attached: bool,
}

#[derive(Debug, Clone)]
pub struct EmbeddedEditorHostEvent {
    pub instance_id: String,
    pub width: u32,
    pub height: u32,
    pub resizable: bool,
}

pub(super) enum UiEvent {
    Wake,
    Exit,
}

#[derive(Clone)]
pub(super) struct UiMailboxWaker {
    wake: Arc<Mutex<Option<UiWakeCallback>>>,
}

type UiWakeCallback = Arc<dyn Fn() + Send + Sync + 'static>;

impl UiMailboxWaker {
    pub(super) fn new(wake: UiWakeCallback) -> Self {
        Self {
            wake: Arc::new(Mutex::new(Some(wake))),
        }
    }

    pub(super) fn send_event(&self, _event: UiEvent) {
        let wake = self.wake.lock().ok().and_then(|wake| wake.clone());
        if let Some(wake) = wake {
            wake();
        }
    }

    pub(super) fn disable(&self) {
        if let Ok(mut wake) = self.wake.lock() {
            wake.take();
        }
    }
}

pub(super) struct WinitHost {
    pub(super) generation: Arc<AtomicU64>,
    pub(super) proxy: UiMailboxWaker,
    pub(super) inbox: std_mpsc::Receiver<ActorRequest>,
    pub(super) processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    pub(super) audio_engine: Arc<engine::AudioEngine>,
    pub(super) background_sender: mpsc::Sender<ActorRequest>,
    pub(super) host_events: std_mpsc::SyncSender<HostEvent>,
    pub(super) pending_ara_events: VecDeque<HostEvent>,
    pub(super) vst3: Option<vst3::Vst3Runtime>,
    pub(super) ara_graph: Option<LiveMixerGraph>,
    pub(super) compositor: Option<WgpuCompositor>,
    pub(super) editor_owner_window: Option<usize>,
    pub(super) editors: HashMap<WindowId, EditorWindow>,
    pub(super) editor_instances: HashMap<String, WindowId>,
    pub(super) editor_menus: HashMap<WindowId, EditorMenuWindow>,
    pub(super) editor_menu_for_owner: HashMap<WindowId, WindowId>,
    pub(super) editor_clipboard: Option<EditorClipboard>,
    pub(super) next_editor_tick: Option<Instant>,
    pub(super) next_ara_tick: Option<Instant>,
    pub(super) next_retirement_tick: Option<Instant>,
    pub(super) output_parameter_error_reported: bool,
    pub(super) next_sidechain_request_id: u64,
    pub(super) embedded_editor_hosts: HashMap<String, EmbeddedEditorHost>,
    pub(super) embedded_editor_events:
        std::rc::Rc<std::cell::RefCell<VecDeque<EmbeddedEditorHostEvent>>>,
    pub(super) embedded_editor_clipboard: Option<(String, crate::vst3::EditorPluginState)>,
}

impl WinitHost {
    // VST3 controller calls must stay on this thread, but the same thread also
    // owns every native editor window. Bound each mailbox turn so plug-in code
    // cannot indefinitely delay the next platform-message dispatch.
    pub(super) const UI_BATCH: usize = 4;
    pub(super) const UI_BUDGET: std::time::Duration = std::time::Duration::from_millis(2);
    const EDITOR_TICK: Duration = Duration::from_millis(16);
    const ARA_CALLBACK_TICK: Duration = Duration::from_millis(33);
    const RETIREMENT_TICK: Duration = Duration::from_millis(16);

    pub(in crate::runtime) fn disable_ui_wake(&self) {
        self.proxy.disable();
    }
}

#[path = "ui_runtime/ara_events.rs"]
mod ara_events;
#[path = "ui_runtime/editor_commands.rs"]
mod editor_commands;
#[path = "ui_runtime/embedded_editors.rs"]
mod embedded_editors;
#[path = "ui_runtime/event_loop.rs"]
mod event_loop;
#[path = "ui_runtime/window_config.rs"]
mod window_config;

pub(super) use window_config::{
    plugin_editor_window_attributes, remove_owned_popup, replace_owned_popup,
    should_drain_ui_request, vst3_host_request_payload,
};
