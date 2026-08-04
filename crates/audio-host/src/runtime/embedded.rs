//! In-process audio-host runtime used by the Electron N-API addon.
//!
//! This adapter deliberately stops at the native library boundary. Control
//! requests use bounded in-process channels, telemetry reads the engine
//! directly, and the host UI event loop is pumped by Electron's main thread.
//! No process bootstrap, OS IPC, shared-memory descriptor, or helper watchdog
//! participates in this path.

use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc as std_mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use heron_dsp_runtime::protocol::{
    ControlCommand, ControlRequest, ControlResponse, ControlResult, HostEvent, ParameterCommand,
    ParameterTargetKind, PriorityCommand, PriorityRequest, PriorityResponse, PriorityResult,
};
use winit::{event_loop::EventLoop, platform::pump_events::EventLoopExtPumpEvents};

use super::{
    ActorRequest, Arc as RuntimeArc, AtomicU64 as RuntimeAtomicU64, GraphParameterHandles,
    HashMap as RuntimeHashMap, MIDI_INPUT, Mutex as RuntimeMutex, NativeUiContext, RuntimeConfig,
    UiEvent, Vst3ActorDeps, WinitHost, WorkerSupervisor, background_io_actor, dispatch_actor,
    dispatch_parameter, editor_platform, engine, engine_actor, is_background_io_command,
    is_vst3_command, mpsc, slow_request_threshold, stable_runtime_handle, std_mpsc as runtime_mpsc,
    vst3, vst3_actor,
};

const ACTOR_CAPACITY: usize = 64;
const CONTROL_CAPACITY: usize = 256;
const UI_MAILBOX_CAPACITY: usize = 64;
const EVENT_CAPACITY: usize = 256;

fn transport_state_code(state: &str) -> u32 {
    match state {
        "playing" => 1,
        "recording" => 2,
        "waiting" => 3,
        "counting-in" => 4,
        _ => 0,
    }
}

thread_local! {
    static UI_RUNTIMES: RefCell<HashMap<u64, EmbeddedUiRuntime>> = RefCell::new(HashMap::new());
}

static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy)]
pub struct EmbeddedRuntimeConfig {
    pub worker_threads: usize,
    pub max_blocking_threads: usize,
}

impl EmbeddedRuntimeConfig {
    #[must_use]
    pub fn auto() -> Self {
        let config = RuntimeConfig::auto();
        Self {
            worker_threads: config.worker_threads,
            max_blocking_threads: config.max_blocking_threads,
        }
    }

    fn validate(self) -> Result<RuntimeConfig, EmbeddedRuntimeError> {
        RuntimeConfig {
            worker_threads: self.worker_threads,
            max_blocking_threads: self.max_blocking_threads,
            // Egress does not exist in the embedded runtime. Keep this valid
            // only because RuntimeConfig is also used to construct Tokio.
            egress_concurrency: 1,
        }
        .validate()
        .map_err(EmbeddedRuntimeError::Configuration)
    }
}

#[derive(Debug)]
pub enum EmbeddedRuntimeError {
    AlreadyRunning,
    Closed,
    Configuration(String),
    EventLoop(String),
    NativeUi(String),
    RuntimeThread(String),
    Serialization(String),
}

impl fmt::Display for EmbeddedRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyRunning => {
                formatter.write_str("an embedded audio runtime is already active")
            }
            Self::Closed => formatter.write_str("the embedded audio runtime is closed"),
            Self::Configuration(message) => {
                write!(formatter, "invalid runtime configuration: {message}")
            }
            Self::EventLoop(message) => write!(
                formatter,
                "could not create native UI event loop: {message}"
            ),
            Self::NativeUi(message) => {
                write!(formatter, "could not initialize native UI: {message}")
            }
            Self::RuntimeThread(message) => {
                write!(formatter, "embedded audio runtime thread failed: {message}")
            }
            Self::Serialization(message) => {
                write!(formatter, "embedded audio serialization failed: {message}")
            }
        }
    }
}

impl std::error::Error for EmbeddedRuntimeError {}

#[derive(Debug, Clone)]
pub struct EmbeddedMeter {
    pub runtime_handle: u32,
    pub pre_left: f32,
    pub pre_right: f32,
    pub post_left: f32,
    pub post_right: f32,
    pub held_left: f32,
    pub held_right: f32,
    pub clipped: bool,
}

#[derive(Debug, Clone)]
pub struct EmbeddedTelemetry {
    pub epoch: u64,
    pub graph_revision: u64,
    pub callback_generation: u64,
    pub transport_state: u32,
    pub position_frames: u64,
    pub sample_rate: u32,
    pub meters: Vec<EmbeddedMeter>,
}

#[derive(Debug, Clone, Copy)]
pub enum EmbeddedParameterEnqueue {
    Queued,
    Full,
    StaleEpoch,
}

struct DirectRequest {
    request: ControlRequest,
    reply: tokio::sync::oneshot::Sender<ControlResponse>,
    submitted_at: Instant,
    slow_threshold: Duration,
}

enum DirectMessage {
    Request(Box<DirectRequest>),
    Parameter(ParameterCommand),
    Close,
}

struct EmbeddedState {
    runtime_id: u64,
    session_epoch: u64,
    messages: mpsc::Sender<DirectMessage>,
    audio_engine: Arc<engine::AudioEngine>,
    host_events: Mutex<std_mpsc::Receiver<HostEvent>>,
    queued_events: Mutex<VecDeque<HostEvent>>,
    winit_generation: Arc<AtomicU64>,
    control_generation: AtomicU64,
    pending_requests: AtomicUsize,
    slow_requests: Arc<AtomicU64>,
    parameter_sequence: AtomicU64,
    parameter_full: AtomicU64,
    parameter_stale: AtomicU64,
    last_graph_event: AtomicU64,
    closed: AtomicBool,
    runtime_thread: Mutex<Option<thread::JoinHandle<()>>>,
    config: EmbeddedRuntimeConfig,
}

struct PendingRequest {
    state: Arc<EmbeddedState>,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.state.pending_requests.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Clone)]
pub struct EmbeddedAudioHost {
    state: Arc<EmbeddedState>,
}

struct EmbeddedUiRuntime {
    event_loop: EventLoop<UiEvent>,
    application: WinitHost,
    _native_ui: NativeUiContext,
}

impl EmbeddedUiRuntime {
    fn pump(&mut self) {
        let _ = self
            .event_loop
            .pump_app_events(Some(Duration::ZERO), &mut self.application);
    }
}

impl EmbeddedAudioHost {
    pub fn start(
        config: EmbeddedRuntimeConfig,
        editor_owner_window: Option<usize>,
    ) -> Result<Self, EmbeddedRuntimeError> {
        let runtime_config = config.validate()?;
        let already_running = UI_RUNTIMES.with(|runtimes| !runtimes.borrow().is_empty());
        if already_running {
            return Err(EmbeddedRuntimeError::AlreadyRunning);
        }

        let _ = MIDI_INPUT.set(super::super::midi_input::MidiInputActor::start(
            heron_dsp_runtime::protocol::MidiSyncPreferences {
                enabled: false,
                source_port_id: None,
                source_port_name: None,
                input_offsets_ms: std::collections::BTreeMap::new(),
                control_port_ids: std::collections::BTreeSet::new(),
                capture_all_controls: false,
            },
        ));
        editor_platform::configure_process_application_identity()
            .map_err(EmbeddedRuntimeError::NativeUi)?;
        let native_ui = NativeUiContext::initialize().map_err(EmbeddedRuntimeError::NativeUi)?;
        let mut event_loop_builder = EventLoop::<UiEvent>::with_user_event();
        #[cfg(target_os = "macos")]
        {
            use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
            event_loop_builder
                .with_activation_policy(ActivationPolicy::Accessory)
                .with_default_menu(false)
                .with_activate_ignoring_other_apps(false);
        }
        let event_loop = event_loop_builder
            .build()
            .map_err(|error| EmbeddedRuntimeError::EventLoop(error.to_string()))?;
        let proxy = event_loop.create_proxy();
        let application_proxy = proxy.clone();
        let (ui_sender, ui_inbox) = runtime_mpsc::sync_channel(UI_MAILBOX_CAPACITY);
        let (host_event_sender, host_event_inbox) = runtime_mpsc::sync_channel(EVENT_CAPACITY);
        let (background_sender, background_inbox) = mpsc::channel(ACTOR_CAPACITY);
        let processors = RuntimeArc::new(RuntimeMutex::new(RuntimeHashMap::new()));
        let audio_engine = Arc::new(engine::AudioEngine::new());
        let winit_generation = Arc::new(RuntimeAtomicU64::new(0));
        let session_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(1, |value| {
                (value.as_nanos() as u64) ^ u64::from(std::process::id())
            })
            .max(1);
        let runtime_id = NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed);
        let (messages, inbox) = mpsc::channel(CONTROL_CAPACITY);

        let application = WinitHost {
            generation: Arc::clone(&winit_generation),
            proxy: application_proxy,
            inbox: ui_inbox,
            processors: Arc::clone(&processors),
            audio_engine: Arc::clone(&audio_engine),
            background_sender: background_sender.clone(),
            host_events: host_event_sender,
            pending_ara_events: VecDeque::new(),
            vst3: Some(vst3::Vst3Runtime::new()),
            ara_graph: None,
            compositor: None,
            editor_owner_window,
            editors: HashMap::new(),
            editor_instances: HashMap::new(),
            editor_menus: HashMap::new(),
            editor_menu_for_owner: HashMap::new(),
            editor_clipboard: None,
            next_editor_tick: None,
            next_ara_tick: None,
            next_retirement_tick: None,
            output_parameter_error_reported: false,
            next_sidechain_request_id: 1,
        };

        let protocol_engine = Arc::clone(&audio_engine);
        let protocol_processors = Arc::clone(&processors);
        let protocol_winit_generation = Arc::clone(&winit_generation);
        let protocol_proxy = proxy.clone();
        let slow_requests = Arc::new(AtomicU64::new(0));
        let protocol_slow_requests = Arc::clone(&slow_requests);
        let runtime_thread = thread::Builder::new()
            .name("heron-embedded-control".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(runtime_config.worker_threads)
                    .max_blocking_threads(runtime_config.max_blocking_threads)
                    .thread_name("heron-embedded-tokio")
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        eprintln!("embedded audio runtime could not start Tokio: {error}");
                        let _ = protocol_proxy.send_event(UiEvent::Exit);
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(
                    &runtime,
                    run_direct_actor(
                        inbox,
                        ui_sender,
                        protocol_proxy,
                        protocol_processors,
                        protocol_engine,
                        protocol_winit_generation,
                        background_sender,
                        background_inbox,
                        session_epoch,
                        protocol_slow_requests,
                    ),
                );
            })
            .map_err(|error| EmbeddedRuntimeError::RuntimeThread(error.to_string()))?;

        let state = Arc::new(EmbeddedState {
            runtime_id,
            session_epoch,
            messages,
            audio_engine,
            host_events: Mutex::new(host_event_inbox),
            queued_events: Mutex::new(VecDeque::new()),
            winit_generation,
            control_generation: AtomicU64::new(0),
            pending_requests: AtomicUsize::new(0),
            slow_requests,
            parameter_sequence: AtomicU64::new(1),
            parameter_full: AtomicU64::new(0),
            parameter_stale: AtomicU64::new(0),
            last_graph_event: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            runtime_thread: Mutex::new(Some(runtime_thread)),
            config,
        });
        UI_RUNTIMES.with(|runtimes| {
            runtimes.borrow_mut().insert(
                runtime_id,
                EmbeddedUiRuntime {
                    event_loop,
                    application,
                    _native_ui: native_ui,
                },
            );
        });
        Ok(Self { state })
    }

    #[must_use]
    pub fn session_epoch(&self) -> u64 {
        self.state.session_epoch
    }

    #[must_use]
    pub fn resolved_config(&self) -> EmbeddedRuntimeConfig {
        self.state.config
    }

    #[must_use]
    pub fn pending_requests(&self) -> usize {
        self.state.pending_requests.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn slow_requests(&self) -> u64 {
        self.state.slow_requests.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn parameter_full(&self) -> u64 {
        self.state.parameter_full.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn parameter_stale(&self) -> u64 {
        self.state.parameter_stale.load(Ordering::Relaxed)
    }

    pub async fn request(
        &self,
        request: ControlRequest,
    ) -> Result<ControlResponse, EmbeddedRuntimeError> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err(EmbeddedRuntimeError::Closed);
        }
        let slow_threshold = slow_request_threshold(&request.command);
        let (reply, response) = tokio::sync::oneshot::channel();
        self.state.pending_requests.fetch_add(1, Ordering::AcqRel);
        let pending = PendingRequest {
            state: Arc::clone(&self.state),
        };
        let send = self
            .state
            .messages
            .send(DirectMessage::Request(Box::new(DirectRequest {
                request,
                reply,
                submitted_at: Instant::now(),
                slow_threshold,
            })))
            .await;
        if send.is_err() {
            return Err(EmbeddedRuntimeError::Closed);
        }
        let result = response.await.map_err(|_| EmbeddedRuntimeError::Closed);
        drop(pending);
        result
    }

    pub fn priority(
        &self,
        request: PriorityRequest,
    ) -> Result<PriorityResponse, EmbeddedRuntimeError> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err(EmbeddedRuntimeError::Closed);
        }
        self.state
            .control_generation
            .fetch_add(1, Ordering::Relaxed);
        let result = match request.command {
            PriorityCommand::Heartbeat => {
                let (callback_generation, transport_state) =
                    self.state.audio_engine.heartbeat_snapshot();
                PriorityResult::Heartbeat {
                    ipc_generation: 0,
                    tokio_generation: self.state.control_generation.load(Ordering::Relaxed),
                    winit_generation: self.state.winit_generation.load(Ordering::Acquire),
                    callback_generation,
                    transport_state,
                    egress_active: 0,
                    egress_queue_depth: 0,
                    egress_queue_high_water: 0,
                    egress_batches: 0,
                    blocking_jobs: 0,
                    arena_regions: 0,
                    arena_capacity_bytes: 0,
                    arena_used_bytes: 0,
                    arena_high_water_bytes: 0,
                    arena_offers: 0,
                    arena_busy: 0,
                    arena_quarantined_regions: 0,
                    arena_copied_bytes: 0,
                }
            }
            PriorityCommand::ParameterBoundary { command } => {
                match self.enqueue_parameter(command) {
                    EmbeddedParameterEnqueue::Queued => PriorityResult::Accepted,
                    EmbeddedParameterEnqueue::Full => PriorityResult::Busy,
                    EmbeddedParameterEnqueue::StaleEpoch => PriorityResult::Busy,
                }
            }
            PriorityCommand::Shutdown => match self.state.messages.try_send(DirectMessage::Close) {
                Ok(()) => PriorityResult::Accepted,
                Err(mpsc::error::TrySendError::Full(_)) => PriorityResult::Busy,
                Err(mpsc::error::TrySendError::Closed(_)) => PriorityResult::Accepted,
            },
            PriorityCommand::ParameterWake
            | PriorityCommand::ReleaseLeases { .. }
            | PriorityCommand::TelemetryPageReady { .. } => PriorityResult::Accepted,
        };
        Ok(PriorityResponse {
            request_id: request.request_id,
            result,
        })
    }

    pub fn next_parameter_sequence(&self) -> u64 {
        self.state
            .parameter_sequence
            .fetch_add(1, Ordering::Relaxed)
    }

    pub fn enqueue_parameter(&self, command: ParameterCommand) -> EmbeddedParameterEnqueue {
        if command.session_epoch != self.state.session_epoch {
            self.state.parameter_stale.fetch_add(1, Ordering::Relaxed);
            return EmbeddedParameterEnqueue::StaleEpoch;
        }
        match self
            .state
            .messages
            .try_send(DirectMessage::Parameter(command))
        {
            Ok(()) => EmbeddedParameterEnqueue::Queued,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.state.parameter_full.fetch_add(1, Ordering::Relaxed);
                EmbeddedParameterEnqueue::Full
            }
            Err(mpsc::error::TrySendError::Closed(_)) => EmbeddedParameterEnqueue::StaleEpoch,
        }
    }

    pub fn pump_events(&self) -> Result<(), EmbeddedRuntimeError> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err(EmbeddedRuntimeError::Closed);
        }
        let found = UI_RUNTIMES.with(|runtimes| {
            let mut runtimes = runtimes.borrow_mut();
            let Some(runtime) = runtimes.get_mut(&self.state.runtime_id) else {
                return false;
            };
            runtime.pump();
            true
        });
        found.then_some(()).ok_or(EmbeddedRuntimeError::Closed)
    }

    #[must_use]
    pub fn telemetry(&self) -> EmbeddedTelemetry {
        let graph_revision = self.state.audio_engine.published_graph_generation();
        let (callback_generation, transport_state) = self.state.audio_engine.heartbeat_snapshot();
        let transport = self.state.audio_engine.transport_snapshot().ok();
        let meters = self
            .state
            .audio_engine
            .mixer_snapshot()
            .map(|snapshot| snapshot.meters)
            .unwrap_or_default()
            .iter()
            .map(|meter| EmbeddedMeter {
                runtime_handle: stable_runtime_handle(1, &meter.channel_id),
                pre_left: meter.pre_left as f32,
                pre_right: meter.pre_right as f32,
                post_left: meter.post_left as f32,
                post_right: meter.post_right as f32,
                held_left: meter.held_left as f32,
                held_right: meter.held_right as f32,
                clipped: meter.clipped,
            })
            .collect();
        EmbeddedTelemetry {
            epoch: self.state.session_epoch,
            graph_revision,
            callback_generation,
            transport_state: transport_state_code(&transport_state),
            position_frames: transport
                .as_ref()
                .map_or(0, |value| value.position_frames.max(0) as u64),
            sample_rate: transport.as_ref().map_or(0, |value| value.sample_rate),
            meters,
        }
    }

    pub fn drain_events(&self) -> Vec<HostEvent> {
        if let Ok(receiver) = self.state.host_events.lock()
            && let Ok(mut queue) = self.state.queued_events.lock()
        {
            for event in receiver.try_iter() {
                if queue.len() == EVENT_CAPACITY {
                    queue.pop_front();
                }
                queue.push_back(event);
            }
        }
        let revision = self.state.audio_engine.published_graph_generation();
        if revision != 0
            && self.state.last_graph_event.swap(revision, Ordering::AcqRel) != revision
            && let Ok(mut queue) = self.state.queued_events.lock()
        {
            queue.push_back(HostEvent::GraphPublished { revision });
        }
        self.state
            .queued_events
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default()
    }

    pub fn close(&self) {
        if self.state.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let runtime_thread = self
            .state
            .runtime_thread
            .lock()
            .ok()
            .and_then(|mut thread| thread.take());
        if let Some(runtime_thread) = runtime_thread {
            let messages = self.state.messages.clone();
            if let Err(error) = thread::Builder::new()
                .name("heron-embedded-close".into())
                .spawn(move || {
                    let _ = messages.blocking_send(DirectMessage::Close);
                    let _ = runtime_thread.join();
                })
            {
                eprintln!("audio-host: could not start runtime close task: {error}");
            }
        }
        UI_RUNTIMES.with(|runtimes| {
            if let Some(runtime) = runtimes.borrow_mut().remove(&self.state.runtime_id) {
                // winit and native plug-in UI facilities are process-scoped on
                // desktop platforms. The runtime is created once, so avoid
                // third-party DLL and COM teardown during application exit.
                // In particular, do not pump or close plug-in windows here:
                // `close` is a non-blocking boundary and the OS owns final
                // process teardown.
                std::mem::forget(runtime);
            }
        });
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_direct_actor(
    mut inbox: mpsc::Receiver<DirectMessage>,
    ui_sender: std_mpsc::SyncSender<ActorRequest>,
    ui_proxy: winit::event_loop::EventLoopProxy<UiEvent>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    audio_engine: Arc<engine::AudioEngine>,
    _winit_generation: Arc<AtomicU64>,
    background_sender: mpsc::Sender<ActorRequest>,
    background_inbox: mpsc::Receiver<ActorRequest>,
    session_epoch: u64,
    slow_requests: Arc<AtomicU64>,
) {
    let handles = Arc::new(Mutex::new(GraphParameterHandles::default()));
    let (engine_sender, engine_inbox) = mpsc::channel(ACTOR_CAPACITY);
    let (vst3_sender, vst3_inbox) = mpsc::channel(ACTOR_CAPACITY);
    let worker_supervisor = WorkerSupervisor::new();
    tokio::spawn(engine_actor(
        engine_inbox,
        Arc::clone(&handles),
        Arc::clone(&audio_engine),
    ));
    tokio::task::spawn_local(vst3_actor(
        vst3_inbox,
        Vst3ActorDeps {
            ui_proxy: ui_proxy.clone(),
            ui_sender,
            processors,
            handles,
            background_sender: background_sender.clone(),
            engine_sender: engine_sender.clone(),
            audio_engine: Arc::clone(&audio_engine),
            session_epoch,
        },
    ));
    tokio::spawn(background_io_actor(
        background_inbox,
        engine_sender.clone(),
        worker_supervisor,
        Arc::clone(&audio_engine),
    ));

    while let Some(message) = inbox.recv().await {
        match message {
            DirectMessage::Close => {
                let engine = Arc::clone(&audio_engine);
                let _ = tokio::task::spawn_blocking(move || engine.stop_audio_engine()).await;
                let _ = ui_proxy.send_event(UiEvent::Exit);
                break;
            }
            DirectMessage::Parameter(command) => {
                let sender = match command.target_kind {
                    ParameterTargetKind::Plugin => &vst3_sender,
                    ParameterTargetKind::MixerChannel | ParameterTargetKind::MixerSend => {
                        &engine_sender
                    }
                };
                let sender = sender.clone();
                tokio::spawn(async move {
                    let _ = dispatch_parameter(&sender, command).await;
                });
            }
            DirectMessage::Request(request) => {
                let DirectRequest {
                    request,
                    reply,
                    submitted_at,
                    slow_threshold,
                } = *request;
                let engine_sender = engine_sender.clone();
                let vst3_sender = vst3_sender.clone();
                let background_sender = background_sender.clone();
                let audio_engine = Arc::clone(&audio_engine);
                let slow_requests = Arc::clone(&slow_requests);
                tokio::spawn(async move {
                    let ControlRequest {
                        request_id,
                        command,
                    } = request;
                    let shutdown = matches!(command, ControlCommand::Shutdown);
                    let work = async move {
                        if shutdown {
                            let _ = tokio::task::spawn_blocking(move || {
                                audio_engine.stop_audio_engine()
                            })
                            .await;
                            ControlResult::Accepted
                        } else {
                            match command {
                                ControlCommand::BenchmarkEcho { payload } => {
                                    ControlResult::BenchmarkEcho { payload }
                                }
                                command if is_vst3_command(&command) => {
                                    dispatch_actor(&vst3_sender, command).await
                                }
                                command if is_background_io_command(&command) => {
                                    dispatch_actor(&background_sender, command).await
                                }
                                command => dispatch_actor(&engine_sender, command).await,
                            }
                        }
                    };
                    let result = await_terminal_result(
                        work,
                        submitted_at,
                        slow_threshold,
                        &slow_requests,
                        request_id,
                    )
                    .await;
                    let _ = reply.send(ControlResponse { request_id, result });
                });
            }
        }
    }
}

async fn await_terminal_result<F>(
    work: F,
    submitted_at: Instant,
    slow_threshold: Duration,
    slow_requests: &AtomicU64,
    request_id: u64,
) -> F::Output
where
    F: std::future::Future,
{
    tokio::pin!(work);
    let elapsed = submitted_at.elapsed();
    if elapsed >= slow_threshold {
        record_slow_request(slow_requests, request_id, slow_threshold);
        return work.await;
    }
    tokio::select! {
        result = &mut work => result,
        () = tokio::time::sleep(slow_threshold - elapsed) => {
            record_slow_request(slow_requests, request_id, slow_threshold);
            work.await
        }
    }
}

fn record_slow_request(counter: &AtomicU64, request_id: u64, threshold: Duration) {
    counter.fetch_add(1, Ordering::Relaxed);
    eprintln!(
        "audio-host: embedded request {request_id} has been pending for {} ms; waiting for its terminal result",
        threshold.as_millis()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn slow_observation_preserves_the_terminal_result() {
        let slow_requests = AtomicU64::new(0);
        let result = await_terminal_result(
            async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                42
            },
            Instant::now(),
            Duration::from_millis(1),
            &slow_requests,
            7,
        )
        .await;

        assert_eq!(result, 42);
        assert_eq!(slow_requests.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn fast_request_does_not_increment_slow_observation() {
        let slow_requests = AtomicU64::new(0);
        let result = await_terminal_result(
            async { 42 },
            Instant::now(),
            Duration::from_secs(1),
            &slow_requests,
            7,
        )
        .await;

        assert_eq!(result, 42);
        assert_eq!(slow_requests.load(Ordering::Relaxed), 0);
    }
}
