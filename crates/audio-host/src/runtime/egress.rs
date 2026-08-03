struct InboundRequest {
    request: ControlRequest,
    received_leases: Vec<u64>,
}

enum PriorityIngress {
    ParameterWake,
    ParameterBoundary(heron_dsp_runtime::protocol::ParameterCommand),
    Shutdown,
    TelemetryPageReady { epoch: u64, generation: u64 },
}

enum OutboundMessage {
    Response {
        value: ControlResponse,
        request_leases: Vec<u64>,
    },
    Event(WirePacket),
}

fn response(request_id: u64, result: ControlResult) -> ControlResponse {
    ControlResponse { request_id, result }
}

#[derive(Clone)]
struct EgressArenas {
    responses: Arc<Mutex<LeaseRegistry>>,
    requests: Arc<Mutex<ArenaReceiver>>,
}

async fn run_egress(
    mut outbound: mpsc::Receiver<OutboundMessage>,
    responses: ipc_channel::ipc::IpcSender<WirePacket>,
    events: ipc_channel::ipc::IpcSender<WirePacket>,
    arenas: EgressArenas,
    concurrency: usize,
    mut shutdown: watch::Receiver<bool>,
    metrics: Arc<EgressMetrics>,
) {
    let permits = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut responses_inflight = JoinSet::new();
    let mut lease_reaper = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        let queue_depth = outbound.len() as u64;
        metrics.queue_depth.store(queue_depth, Ordering::Release);
        metrics
            .queue_high_water
            .fetch_max(queue_depth, Ordering::AcqRel);
        tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    while let Ok(message) = outbound.try_recv() {
                        dispatch_egress(
                            message,
                            &responses,
                            &events,
                            &arenas,
                            &permits,
                            &mut responses_inflight,
                            &metrics,
                        ).await;
                    }
                    break;
                }
            }
            Some(result) = responses_inflight.join_next(), if !responses_inflight.is_empty() => {
                if let Err(error) = result {
                    eprintln!("audio-host: IPC response task failed: {error}");
                }
            }
            _ = lease_reaper.tick() => {
                if let Ok(mut leases) = arenas.responses.lock() {
                    for lease_id in leases.reap_expired() {
                        eprintln!("audio-host: arena lease {lease_id} expired; region quarantined");
                    }
                    publish_arena_metrics(&metrics, &leases);
                }
            }
            message = outbound.recv() => {
                let Some(message) = message else { break };
                dispatch_egress(
                    message,
                    &responses,
                    &events,
                    &arenas,
                    &permits,
                    &mut responses_inflight,
                    &metrics,
                ).await;
            }
        }
    }
    while let Some(result) = responses_inflight.join_next().await {
        if let Err(error) = result {
            eprintln!("audio-host: IPC response task failed during drain: {error}");
        }
    }
    metrics.queue_depth.store(0, Ordering::Release);
}

async fn dispatch_egress(
    message: OutboundMessage,
    responses: &ipc_channel::ipc::IpcSender<WirePacket>,
    events: &ipc_channel::ipc::IpcSender<WirePacket>,
    arenas: &EgressArenas,
    permits: &Arc<Semaphore>,
    inflight: &mut JoinSet<()>,
    metrics: &Arc<EgressMetrics>,
) {
    metrics.batches.fetch_add(1, Ordering::Relaxed);
    match message {
        OutboundMessage::Response {
            value,
            request_leases,
        } => {
            let Ok(permit) = permits.clone().acquire_owned().await else {
                return;
            };
            let responses = responses.clone();
            let events = events.clone();
            let leases = arenas.responses.clone();
            let request_arena = arenas.requests.clone();
            let metrics = metrics.clone();
            metrics.active.fetch_add(1, Ordering::AcqRel);
            metrics.blocking_jobs.fetch_add(1, Ordering::AcqRel);
            inflight.spawn_blocking(move || {
                let _permit = permit;
                let sent = request_arena
                    .lock()
                    .map_err(|_| "request arena is poisoned".to_owned())
                    .and_then(|source| {
                        leases
                            .lock()
                            .map_err(|_| "response arena is poisoned".to_owned())
                            .and_then(|mut arena| {
                                let result = encode_response_from_arena(value, &mut arena, &source)
                                    .map_err(|error| error.to_string());
                                publish_arena_metrics(&metrics, &arena);
                                result
                            })
                    })
                    .and_then(|packet| responses.send(packet).map_err(|error| error.to_string()));
                if let Err(error) = sent {
                    eprintln!("audio-host: IPC response stopped: {error}");
                } else if !request_leases.is_empty()
                    && let Ok(packet) = encode_event(
                        &HostEvent::ReleaseLeases {
                            lease_ids: request_leases,
                        },
                        Vec::new(),
                    )
                    && let Err(error) = events.send(packet)
                {
                    eprintln!("audio-host: request lease release event stopped: {error}");
                }
                metrics.active.fetch_sub(1, Ordering::AcqRel);
                metrics.blocking_jobs.fetch_sub(1, Ordering::AcqRel);
            });
        }
        OutboundMessage::Event(packet) => {
            let events = events.clone();
            metrics.blocking_jobs.fetch_add(1, Ordering::AcqRel);
            let sent = tokio::task::spawn_blocking(move || events.send(packet))
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result.map_err(|error| error.to_string()));
            metrics.blocking_jobs.fetch_sub(1, Ordering::AcqRel);
            if let Err(error) = sent {
                eprintln!("audio-host: IPC event lane stopped: {error}");
            }
        }
    }
}

#[derive(Default)]
struct EgressMetrics {
    active: AtomicU64,
    queue_depth: AtomicU64,
    queue_high_water: AtomicU64,
    batches: AtomicU64,
    blocking_jobs: AtomicU64,
    arena_regions: AtomicU64,
    arena_capacity_bytes: AtomicU64,
    arena_used_bytes: AtomicU64,
    arena_high_water_bytes: AtomicU64,
    arena_offers: AtomicU64,
    arena_busy: AtomicU64,
    arena_quarantined_regions: AtomicU64,
    arena_copied_bytes: AtomicU64,
}

fn publish_arena_metrics(metrics: &EgressMetrics, arena: &LeaseRegistry) {
    let diagnostics = arena.diagnostics();
    metrics
        .arena_regions
        .store(u64::from(diagnostics.region_count), Ordering::Release);
    metrics
        .arena_capacity_bytes
        .store(diagnostics.capacity_bytes, Ordering::Release);
    metrics
        .arena_used_bytes
        .store(diagnostics.used_bytes, Ordering::Release);
    metrics
        .arena_high_water_bytes
        .store(diagnostics.high_water_bytes, Ordering::Release);
    metrics
        .arena_offers
        .store(diagnostics.offers, Ordering::Release);
    metrics
        .arena_busy
        .store(diagnostics.busy, Ordering::Release);
    metrics
        .arena_quarantined_regions
        .store(diagnostics.quarantined_regions, Ordering::Release);
    metrics
        .arena_copied_bytes
        .store(diagnostics.copied_bytes, Ordering::Release);
}
