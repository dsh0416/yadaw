#[napi(object)]
pub struct IpcResponse {
    pub body: Buffer,
    pub attachments: Vec<Buffer>,
}

type ResponseResolver = Box<dyn FnOnce(Env) -> Result<IpcResponse> + Send>;
type ResponseDeferred = JsDeferred<IpcResponse, ResponseResolver>;

fn failure(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

struct Pending {
    deferred: ResponseDeferred,
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
    let worker_threads =
        worker_threads.unwrap_or_else(|| u32::try_from(logical.div_ceil(4).clamp(1, 4)).unwrap());
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
