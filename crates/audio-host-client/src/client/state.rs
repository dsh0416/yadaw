#[napi(object)]
pub struct IpcResponse {
    pub body: Buffer,
    pub attachments: Vec<Buffer>,
}

#[napi(object)]
pub struct ParameterEnqueueResult {
    pub outcome: String,
    pub sequence: String,
}


#[napi(object)]
pub struct ParameterEnqueueRequest {
    pub target_kind: String,
    pub runtime_handle: u32,
    pub parameter_id: u32,
    pub normalized: f64,
    pub gesture: String,
    pub sequence: Option<String>,
    pub target_generation: Option<u32>,
}
type ResponseResolver = Box<dyn FnOnce(Env) -> Result<IpcResponse> + Send>;
type ResponseDeferred = JsDeferred<IpcResponse, ResponseResolver>;

trait PendingResponder: Send {
    fn resolve(self: Box<Self>, bytes: Vec<u8>, attachments: Vec<Vec<u8>>);
    fn reject(self: Box<Self>, error: Error);
}

struct NapiPendingResponder(ResponseDeferred);

impl PendingResponder for NapiPendingResponder {
    fn resolve(self: Box<Self>, bytes: Vec<u8>, attachments: Vec<Vec<u8>>) {
        self.0.resolve(Box::new(move |_env| {
            Ok(IpcResponse {
                body: bytes.into(),
                attachments: attachments.into_iter().map(Buffer::from).collect(),
            })
        }));
    }

    fn reject(self: Box<Self>, error: Error) {
        self.0.reject(error);
    }
}

fn failure(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn negotiate_shared_pages(
    commands: &IpcSender<MappingCommand>,
    events: &IpcReceiver<MappingEvent>,
    telemetry: &TelemetryReader,
    parameters: &ParameterProducer,
) -> bool {
    const TIMEOUT: Duration = Duration::from_secs(5);
    let telemetry_generation = telemetry.descriptor().generation();
    let parameter_generation = parameters.descriptor().generation();
    let mapped = matches!(
        events.try_recv_timeout(TIMEOUT),
        Ok(MappingEvent::Mapped {
            telemetry_generation: received_telemetry,
            parameter_generation: received_parameter,
        }) if received_telemetry == telemetry_generation
            && received_parameter == parameter_generation
    );
    if !mapped || !telemetry.peer_verified() || !parameters.peer_verified() {
        let _ = commands.send(MappingCommand::Abort);
        return false;
    }
    if telemetry.unlink().is_err() || parameters.unlink().is_err() {
        let _ = commands.send(MappingCommand::Abort);
        return false;
    }
    if commands
        .send(MappingCommand::Activate {
            telemetry_generation,
            parameter_generation,
        })
        .is_err()
    {
        return false;
    }
    matches!(
        events.try_recv_timeout(TIMEOUT),
        Ok(MappingEvent::Active {
            telemetry_generation: received_telemetry,
            parameter_generation: received_parameter,
        }) if received_telemetry == telemetry_generation
            && received_parameter == parameter_generation
    )
}

struct Pending {
    responder: Box<dyn PendingResponder>,
    deadline: Instant,
}

#[derive(Default)]
struct TransportTraffic {
    inline_packets: AtomicU64,
    inline_bytes: AtomicU64,
    shared_packets: AtomicU64,
    shared_regions: AtomicU64,
    shared_bytes: AtomicU64,
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
    persistent_shared_pages: bool,
    shared_page_activation_failures: AtomicU64,
    events: Arc<Mutex<VecDeque<Vec<u8>>>>,
    child: Mutex<Child>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    closing: Arc<AtomicBool>,
    session_epoch: u64,
    parameter_sequence: AtomicU64,
    internal_request_id: AtomicU64,
    telemetry_fallback_reads: AtomicU64,
    parameter_soft_full: AtomicU64,
    parameter_hard_full: AtomicU64,
    parameter_boundary_fallbacks: AtomicU64,
    parameter_stale_epoch: AtomicU64,
    request_timeouts: Arc<AtomicU64>,
    transport_traffic: Arc<TransportTraffic>,
    runtime_config: ResolvedRuntimeConfig,
}

#[derive(Clone, Copy)]
struct ResolvedRuntimeConfig {
    worker_threads: u32,
    max_blocking_threads: u32,
    egress_concurrency: u32,
}

fn resolve_runtime_config(
    worker_threads: Option<u32>,
    max_blocking_threads: Option<u32>,
    egress_concurrency: Option<u32>,
) -> Result<ResolvedRuntimeConfig> {
    let logical = thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    let default_worker_threads = logical.div_ceil(4).clamp(1, 4) as u32;
    let worker_threads = worker_threads.unwrap_or(default_worker_threads);
    let max_blocking_threads =
        max_blocking_threads.unwrap_or_else(|| (worker_threads.saturating_mul(2)).clamp(2, 8));
    let egress_concurrency = egress_concurrency.unwrap_or_else(|| 2.min(max_blocking_threads));
    if !(1..=8).contains(&worker_threads)
        || !(2..=16).contains(&max_blocking_threads)
        || !(1..=4).contains(&egress_concurrency)
        || egress_concurrency > max_blocking_threads
    {
        return Err(Error::new(
            Status::InvalidArg,
            "invalid audio-host runtime thread configuration",
        ));
    }
    Ok(ResolvedRuntimeConfig {
        worker_threads,
        max_blocking_threads,
        egress_concurrency,
    })
}

fn decode_native_window_handle(handle: Option<&[u8]>) -> Result<Option<usize>> {
    let Some(handle) = handle else {
        return Ok(None);
    };
    if handle.len() != size_of::<usize>() {
        return Err(failure(
            "invalid editor owner window handle",
            format!(
                "expected {} bytes, received {}",
                size_of::<usize>(),
                handle.len()
            ),
        ));
    }
    let bytes: [u8; size_of::<usize>()] = handle
        .try_into()
        .map_err(|_| failure("invalid editor owner window handle", "invalid byte length"))?;
    let handle = usize::from_ne_bytes(bytes);
    if handle == 0 {
        return Err(failure(
            "invalid editor owner window handle",
            "window handle is null",
        ));
    }
    Ok(Some(handle))
}
