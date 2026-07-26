use std::{
    collections::{HashMap, VecDeque},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use ipc_channel::{
    TryRecvError,
    ipc::{self, IpcOneShotServer, IpcReceiver, IpcSender},
};
use napi::{
    Env, Error, JsDeferred, Result, Status,
    bindgen_prelude::{Buffer, Object},
};
use napi_derive::napi;
use yadaw_dsp_runtime::protocol::{
    ControlCommand, ControlRequest, HostEvent, MAX_MESSAGE_BYTES, PROTOCOL_VERSION,
    ParameterCommand, ParameterGesture, ParameterTargetKind, PriorityCommand, PriorityRequest,
    PriorityResponse,
};
use yadaw_ipc_transport::{
    HostBootstrap, LeaseRegistry, ParameterEnqueue, ParameterProducer, TelemetryReader,
    TelemetrySnapshot, WirePacket, create_parameter_ring, create_telemetry_page, decode_body,
    decode_response, encode_body, encode_priority, encode_request,
};

const OUTBOUND_CAPACITY: usize = 256;
const ROUTER_POLL: Duration = Duration::from_millis(50);
const MAX_LOGICAL_REQUEST_BYTES: usize = MAX_MESSAGE_BYTES * 2;

type BufferResolver = Box<dyn FnOnce(Env) -> Result<Buffer> + Send>;
type BufferDeferred = JsDeferred<Buffer, BufferResolver>;

fn failure(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

struct Pending {
    deferred: BufferDeferred,
    deadline: Instant,
}

struct ClientState {
    normal_outbound: Mutex<Option<SyncSender<WirePacket>>>,
    priority_outbound: Mutex<Option<SyncSender<WirePacket>>>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    priority_pending: Arc<Mutex<HashMap<u64, Pending>>>,
    leases: Arc<Mutex<LeaseRegistry>>,
    telemetry: Arc<RwLock<TelemetryReader>>,
    last_telemetry: Mutex<TelemetrySnapshot>,
    parameters: ParameterProducer,
    events: Arc<Mutex<VecDeque<Vec<u8>>>>,
    child: Mutex<Child>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    closing: Arc<AtomicBool>,
    session_epoch: u64,
    parameter_sequence: AtomicU64,
    internal_request_id: AtomicU64,
}

#[napi]
pub struct AudioHostIpcClient {
    state: Arc<ClientState>,
}

#[napi]
impl AudioHostIpcClient {
    #[napi(constructor)]
    pub fn new(
        executable_path: String,
        bridge_path: String,
        crash_marker_path: String,
    ) -> Result<Self> {
        let (server, token) = IpcOneShotServer::<IpcSender<HostBootstrap>>::new()
            .map_err(|error| failure("could not create helper IPC server", error))?;
        let mut child = Command::new(&executable_path)
            .arg("--ipc-token")
            .arg(token)
            .arg("--vst3-bridge")
            .arg(bridge_path)
            .arg("--crash-marker")
            .arg(crash_marker_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| failure("could not start audio host", error))?;

        let (requests, request_receiver) =
            ipc::channel().map_err(|error| failure("could not create request channel", error))?;
        let (response_sender, responses) =
            ipc::channel().map_err(|error| failure("could not create response channel", error))?;
        let (priority_requests, priority_request_receiver) = ipc::channel()
            .map_err(|error| failure("could not create priority request channel", error))?;
        let (priority_response_sender, priority_responses) = ipc::channel()
            .map_err(|error| failure("could not create priority response channel", error))?;
        let (event_sender, events) =
            ipc::channel().map_err(|error| failure("could not create event channel", error))?;

        let session_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(1, |value| {
                (value.as_nanos() as u64) ^ u64::from(std::process::id())
            })
            .max(1);
        let telemetry_page = create_telemetry_page(64, session_epoch)
            .map_err(|error| failure("could not create telemetry page", error))?;
        let parameter_ring = create_parameter_ring(session_epoch)
            .map_err(|error| failure("could not create parameter ring", error))?;
        let telemetry = TelemetryReader::map(telemetry_page.clone())
            .map_err(|error| failure("could not map telemetry page", error))?;
        let parameters = ParameterProducer::map(parameter_ring.clone())
            .map_err(|error| failure("could not map parameter ring", error))?;

        let (_, bootstrap_sender) = server.accept().map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            failure("audio host did not connect to IPC", error)
        })?;
        bootstrap_sender
            .send(HostBootstrap {
                protocol_version: PROTOCOL_VERSION,
                requests: request_receiver,
                responses: response_sender,
                priority_requests: priority_request_receiver,
                priority_responses: priority_response_sender,
                events: event_sender,
                telemetry_page,
                parameter_ring,
                session_epoch,
            })
            .map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                failure("could not transfer helper channels", error)
            })?;

        let (normal_outbound, normal_inbox) = mpsc::sync_channel(OUTBOUND_CAPACITY);
        let (priority_outbound, priority_inbox) = mpsc::sync_channel(OUTBOUND_CAPACITY);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let priority_pending = Arc::new(Mutex::new(HashMap::new()));
        let leases = Arc::new(Mutex::new(LeaseRegistry::new()));
        let telemetry = Arc::new(RwLock::new(telemetry));
        let event_queue = Arc::new(Mutex::new(VecDeque::new()));
        let closing = Arc::new(AtomicBool::new(false));

        let normal_egress = spawn_egress("yadaw-ipc-request", requests, normal_inbox);
        let priority_egress = spawn_egress(
            "yadaw-ipc-priority-request",
            priority_requests,
            priority_inbox,
        );
        let response_router = spawn_response_router(
            responses,
            Arc::clone(&pending),
            priority_outbound.clone(),
            Arc::clone(&closing),
        );
        let priority_router = spawn_priority_router(
            priority_responses,
            Arc::clone(&priority_pending),
            Arc::clone(&closing),
        );
        let event_router = spawn_event_router(
            events,
            Arc::clone(&leases),
            Arc::clone(&telemetry),
            Arc::clone(&event_queue),
            priority_outbound.clone(),
            Arc::clone(&closing),
        );
        // Routers own outbound sender clones, so they must be joined before the
        // egress threads waiting for every sender to be dropped.
        let threads = vec![
            response_router,
            priority_router,
            event_router,
            normal_egress,
            priority_egress,
        ];

        Ok(Self {
            state: Arc::new(ClientState {
                normal_outbound: Mutex::new(Some(normal_outbound)),
                priority_outbound: Mutex::new(Some(priority_outbound)),
                pending,
                priority_pending,
                leases,
                telemetry,
                last_telemetry: Mutex::new(TelemetrySnapshot {
                    epoch: session_epoch,
                    graph_revision: 0,
                    callback_generation: 0,
                    transport_state: 0,
                    position_frames: 0,
                    sample_rate: 0,
                    meters: Vec::new(),
                }),
                parameters,
                events: event_queue,
                child: Mutex::new(child),
                threads: Mutex::new(threads),
                closing,
                session_epoch,
                parameter_sequence: AtomicU64::new(1),
                internal_request_id: AtomicU64::new(u64::MAX / 2),
            }),
        })
    }

    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn request<'env>(
        &self,
        env: &'env Env,
        message_pack_request: Buffer,
    ) -> Result<Object<'env>> {
        if self.state.closing.load(Ordering::Acquire) {
            return Err(failure("audio-host request", "client is closing"));
        }
        if message_pack_request.len() > MAX_LOGICAL_REQUEST_BYTES {
            return Err(Error::new(
                Status::InvalidArg,
                "audio-host logical request exceeds 128 MiB",
            ));
        }
        let request = rmp_serde::from_slice::<ControlRequest>(&message_pack_request)
            .map_err(|error| failure("invalid audio-host request", error))?;
        if request.version != PROTOCOL_VERSION {
            return Err(failure(
                "audio-host request",
                format!("unsupported protocol {}", request.version),
            ));
        }
        let request_id = request.request_id;
        let deadline = Instant::now() + request_deadline(&request.command);
        let packet = {
            let mut leases = self
                .state
                .leases
                .lock()
                .map_err(|_| failure("audio-host lease registry", "poisoned"))?;
            encode_request(request, &mut leases)
                .map_err(|error| failure("could not encode audio-host request", error))?
        };
        self.create_request_promise(env, request_id, deadline, packet, false)
    }

    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn heartbeat<'env>(
        &self,
        env: &'env Env,
        message_pack_request: Buffer,
    ) -> Result<Object<'env>> {
        let request = rmp_serde::from_slice::<PriorityRequest>(&message_pack_request)
            .map_err(|error| failure("invalid heartbeat request", error))?;
        if request.version != PROTOCOL_VERSION {
            return Err(failure("priority request", "invalid protocol version"));
        }
        let request_id = request.request_id;
        let packet = encode_priority(&request)
            .map_err(|error| failure("could not encode heartbeat request", error))?;
        self.create_request_promise(
            env,
            request_id,
            Instant::now() + Duration::from_secs(2),
            packet,
            true,
        )
    }

    #[napi]
    pub fn read_telemetry(&self) -> Result<Buffer> {
        let snapshot = self
            .state
            .telemetry
            .read()
            .map_err(|_| failure("telemetry page", "poisoned"))?
            .read();
        let snapshot = match snapshot {
            Some(snapshot) => {
                if let Ok(mut previous) = self.state.last_telemetry.lock() {
                    *previous = snapshot.clone();
                }
                snapshot
            }
            None => self
                .state
                .last_telemetry
                .lock()
                .map_err(|_| failure("last telemetry snapshot", "poisoned"))?
                .clone(),
        };
        rmp_serde::to_vec_named(&(
            snapshot.epoch,
            snapshot.graph_revision,
            snapshot.callback_generation,
            snapshot.transport_state,
            snapshot.position_frames,
            snapshot.sample_rate,
            snapshot
                .meters
                .into_iter()
                .map(|meter| {
                    (
                        meter.runtime_handle,
                        meter.pre_left,
                        meter.pre_right,
                        meter.post_left,
                        meter.post_right,
                        meter.held_left,
                        meter.held_right,
                        meter.clipped,
                    )
                })
                .collect::<Vec<_>>(),
        ))
        .map(Buffer::from)
        .map_err(|error| failure("could not encode telemetry snapshot", error))
    }

    #[napi]
    pub fn enqueue_parameter(
        &self,
        target_kind: String,
        runtime_handle: u32,
        parameter_id: u32,
        normalized: f64,
        gesture: String,
    ) -> Result<String> {
        let target_kind = match target_kind.as_str() {
            "plugin" => ParameterTargetKind::Plugin,
            "mixer-channel" => ParameterTargetKind::MixerChannel,
            "mixer-send" => ParameterTargetKind::MixerSend,
            _ => return Err(Error::new(Status::InvalidArg, "invalid parameter target")),
        };
        let gesture = parse_gesture(&gesture)?;
        let command = ParameterCommand {
            session_epoch: self.state.session_epoch,
            sequence: self
                .state
                .parameter_sequence
                .fetch_add(1, Ordering::Relaxed),
            target_kind,
            runtime_handle,
            parameter_id,
            normalized,
            gesture,
        };
        match self.state.parameters.enqueue(command) {
            ParameterEnqueue::Queued { wake } => {
                if wake {
                    self.send_internal_priority(PriorityCommand::ParameterWake)?;
                }
                Ok("queued".into())
            }
            ParameterEnqueue::SoftFull => Ok("soft-full".into()),
            ParameterEnqueue::Full => {
                if matches!(gesture, ParameterGesture::Begin | ParameterGesture::End) {
                    self.send_internal_priority(PriorityCommand::ParameterBoundary { command })?;
                    Ok("fallback".into())
                } else {
                    Ok("full".into())
                }
            }
            ParameterEnqueue::StaleEpoch => Ok("stale".into()),
        }
    }

    #[napi(getter)]
    pub fn session_epoch(&self) -> i64 {
        self.state.session_epoch as i64
    }

    #[napi]
    pub fn drain_events(&self) -> Result<Vec<Buffer>> {
        let mut events = self
            .state
            .events
            .lock()
            .map_err(|_| failure("audio-host event queue", "poisoned"))?;
        Ok(events.drain(..).map(Buffer::from).collect())
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        close_state(&self.state)
    }
}

impl AudioHostIpcClient {
    fn create_request_promise<'env>(
        &self,
        env: &'env Env,
        request_id: u64,
        deadline: Instant,
        packet: WirePacket,
        priority: bool,
    ) -> Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<Buffer, BufferResolver>()?;
        let map = if priority {
            &self.state.priority_pending
        } else {
            &self.state.pending
        };
        {
            let mut pending = map
                .lock()
                .map_err(|_| failure("audio-host pending requests", "poisoned"))?;
            if pending.len() >= OUTBOUND_CAPACITY {
                return Err(failure("audio-host request", "too many requests in flight"));
            }
            if pending
                .insert(request_id, Pending { deferred, deadline })
                .is_some()
            {
                return Err(failure(
                    "audio-host request",
                    "duplicate request identifier",
                ));
            }
        }
        let outbound = if priority {
            &self.state.priority_outbound
        } else {
            &self.state.normal_outbound
        };
        let send = outbound
            .lock()
            .map_err(|_| failure("audio-host outbound queue", "poisoned"))?
            .as_ref()
            .ok_or_else(|| failure("audio-host outbound queue", "closed"))?
            .try_send(packet);
        if let Err(error) = send
            && let Ok(mut pending) = map.lock()
            && let Some(value) = pending.remove(&request_id)
        {
            value
                .deferred
                .reject(failure("could not queue audio-host request", error));
        }
        Ok(promise)
    }

    fn send_internal_priority(&self, command: PriorityCommand) -> Result<()> {
        let request = PriorityRequest {
            version: PROTOCOL_VERSION,
            request_id: self
                .state
                .internal_request_id
                .fetch_add(1, Ordering::Relaxed),
            command,
        };
        let packet = encode_priority(&request)
            .map_err(|error| failure("could not encode priority command", error))?;
        let guard = self
            .state
            .priority_outbound
            .lock()
            .map_err(|_| failure("priority outbound queue", "poisoned"))?;
        guard
            .as_ref()
            .ok_or_else(|| failure("priority outbound queue", "closed"))?
            .try_send(packet)
            .map_err(|error| failure("priority outbound queue", error))
    }
}

fn request_deadline(command: &ControlCommand) -> Duration {
    if matches!(
        command,
        ControlCommand::UpdateGraph { .. }
            | ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ClosePluginEditor { .. }
    ) {
        Duration::from_secs(15)
    } else {
        Duration::from_secs(2)
    }
}

fn parse_gesture(value: &str) -> Result<ParameterGesture> {
    match value {
        "begin" => Ok(ParameterGesture::Begin),
        "perform" => Ok(ParameterGesture::Perform),
        "end" => Ok(ParameterGesture::End),
        _ => Err(Error::new(Status::InvalidArg, "invalid parameter gesture")),
    }
}

fn spawn_egress(
    name: &'static str,
    sender: IpcSender<WirePacket>,
    inbox: Receiver<WirePacket>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            while let Ok(packet) = inbox.recv() {
                if sender.send(packet).is_err() {
                    break;
                }
            }
        })
        .expect("IPC egress thread must start")
}

fn spawn_response_router(
    receiver: IpcReceiver<WirePacket>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    priority_outbound: SyncSender<WirePacket>,
    closing: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("yadaw-ipc-response-router".into())
        .spawn(move || {
            while !closing.load(Ordering::Acquire) {
                match receiver.try_recv_timeout(router_timeout(&pending)) {
                    Ok(packet) => match decode_response(packet) {
                        Ok((response, lease_ids)) => {
                            if !lease_ids.is_empty() {
                                send_release_leases(&priority_outbound, lease_ids);
                            }
                            let request_id = response.request_id;
                            match encode_body(&response) {
                                Ok(bytes) => resolve_pending(&pending, request_id, bytes),
                                Err(error) => reject_pending(
                                    &pending,
                                    request_id,
                                    failure("could not encode audio-host response", error),
                                ),
                            }
                        }
                        Err(error) => {
                            reject_all(&pending, failure("invalid audio-host response", error));
                        }
                    },
                    Err(TryRecvError::Empty) => expire_pending(&pending),
                    Err(TryRecvError::IpcError(error)) => {
                        reject_all(
                            &pending,
                            failure("audio-host response channel closed", error),
                        );
                        break;
                    }
                }
            }
        })
        .expect("response router thread must start")
}

fn spawn_priority_router(
    receiver: IpcReceiver<WirePacket>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    closing: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("yadaw-ipc-priority-router".into())
        .spawn(move || {
            while !closing.load(Ordering::Acquire) {
                match receiver.try_recv_timeout(router_timeout(&pending)) {
                    Ok(packet) => match decode_body::<PriorityResponse>(&packet.body) {
                        Ok(response) => resolve_pending(&pending, response.request_id, packet.body),
                        Err(error) => {
                            reject_all(&pending, failure("invalid priority response", error));
                        }
                    },
                    Err(TryRecvError::Empty) => expire_pending(&pending),
                    Err(TryRecvError::IpcError(error)) => {
                        reject_all(&pending, failure("priority response channel closed", error));
                        break;
                    }
                }
            }
        })
        .expect("priority response router thread must start")
}

fn spawn_event_router(
    receiver: IpcReceiver<WirePacket>,
    leases: Arc<Mutex<LeaseRegistry>>,
    telemetry: Arc<RwLock<TelemetryReader>>,
    events: Arc<Mutex<VecDeque<Vec<u8>>>>,
    priority_outbound: SyncSender<WirePacket>,
    closing: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("yadaw-ipc-event-router".into())
        .spawn(move || {
            while !closing.load(Ordering::Acquire) {
                let packet = match receiver.try_recv_timeout(ROUTER_POLL) {
                    Ok(packet) => packet,
                    Err(TryRecvError::Empty) => {
                        if let Ok(mut registry) = leases.lock() {
                            for lease_id in registry.reap_expired() {
                                eprintln!(
                                    "audio-host-client: temporary shared-memory lease {lease_id} expired"
                                );
                            }
                        }
                        continue;
                    }
                    Err(TryRecvError::IpcError(_)) => break,
                };
                let Ok(event) = decode_body::<HostEvent>(&packet.body) else {
                    continue;
                };
                match &event {
                    HostEvent::ReleaseLeases { lease_ids } => {
                        if let Ok(mut registry) = leases.lock() {
                            registry.release(lease_ids);
                        }
                    }
                    HostEvent::TelemetryPageOffer { epoch, .. } => {
                        if let Some(memory) = packet.regions.into_iter().next()
                            && let Ok(reader) = TelemetryReader::map(memory)
                        {
                            if let Ok(mut current) = telemetry.write() {
                                *current = reader;
                            }
                            let request = PriorityRequest {
                                version: PROTOCOL_VERSION,
                                request_id: 0,
                                command: PriorityCommand::TelemetryPageReady { epoch: *epoch },
                            };
                            if let Ok(packet) = encode_priority(&request) {
                                let _ = priority_outbound.try_send(packet);
                            }
                        }
                    }
                    _ => {
                        if let Ok(mut queue) = events.lock() {
                            if queue.len() == OUTBOUND_CAPACITY {
                                queue.pop_front();
                            }
                            queue.push_back(packet.body);
                        }
                    }
                }
            }
        })
        .expect("event router thread must start")
}

fn send_release_leases(outbound: &SyncSender<WirePacket>, lease_ids: Vec<u64>) {
    let request = PriorityRequest {
        version: PROTOCOL_VERSION,
        request_id: 0,
        command: PriorityCommand::ReleaseLeases { lease_ids },
    };
    if let Ok(packet) = encode_priority(&request) {
        let _ = outbound.try_send(packet);
    }
}

fn resolve_pending(pending: &Mutex<HashMap<u64, Pending>>, request_id: u64, bytes: Vec<u8>) {
    let value = pending
        .lock()
        .ok()
        .and_then(|mut values| values.remove(&request_id));
    if let Some(value) = value {
        value
            .deferred
            .resolve(Box::new(move |_env| Ok(bytes.into())));
    }
}

fn reject_pending(pending: &Mutex<HashMap<u64, Pending>>, request_id: u64, error: Error) {
    let value = pending
        .lock()
        .ok()
        .and_then(|mut values| values.remove(&request_id));
    if let Some(value) = value {
        value.deferred.reject(error);
    }
}

fn expire_pending(pending: &Mutex<HashMap<u64, Pending>>) {
    let now = Instant::now();
    let expired = pending
        .lock()
        .map(|values| {
            values
                .iter()
                .filter_map(|(id, value)| (value.deadline <= now).then_some(*id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for request_id in expired {
        reject_pending(
            pending,
            request_id,
            failure("audio-host request", "deadline exceeded"),
        );
    }
}

fn router_timeout(pending: &Mutex<HashMap<u64, Pending>>) -> Duration {
    let now = Instant::now();
    pending
        .lock()
        .ok()
        .and_then(|values| values.values().map(|value| value.deadline).min())
        .map_or(ROUTER_POLL, |deadline| {
            deadline.saturating_duration_since(now).min(ROUTER_POLL)
        })
}

fn reject_all(pending: &Mutex<HashMap<u64, Pending>>, error: Error) {
    let values = pending
        .lock()
        .map(|mut pending| pending.drain().map(|(_, value)| value).collect::<Vec<_>>())
        .unwrap_or_default();
    for value in values {
        value
            .deferred
            .reject(Error::new(error.status, error.reason.clone()));
    }
}

fn close_state(state: &ClientState) -> Result<()> {
    if state.closing.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    state
        .normal_outbound
        .lock()
        .map_err(|_| failure("normal outbound queue", "poisoned"))?
        .take();
    state
        .priority_outbound
        .lock()
        .map_err(|_| failure("priority outbound queue", "poisoned"))?
        .take();
    let mut child = state
        .child
        .lock()
        .map_err(|_| failure("audio host process lock", "poisoned"))?;
    if child
        .try_wait()
        .map_err(|error| failure("could not inspect audio host", error))?
        .is_none()
    {
        child
            .kill()
            .map_err(|error| failure("could not stop audio host", error))?;
        child
            .wait()
            .map_err(|error| failure("could not reap audio host", error))?;
    }
    reject_all(
        &state.pending,
        failure("audio-host request", "client closed"),
    );
    reject_all(
        &state.priority_pending,
        failure("audio-host request", "client closed"),
    );
    if let Ok(mut threads) = state.threads.lock() {
        for thread in threads.drain(..) {
            let _ = thread.join();
        }
    }
    Ok(())
}

impl Drop for ClientState {
    fn drop(&mut self) {
        let _ = close_state(self);
    }
}
