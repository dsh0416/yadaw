fn spawn_event_router(
    receiver: IpcReceiver<WirePacket>,
    leases: Arc<Mutex<LeaseRegistry>>,
    telemetry: Arc<RwLock<TelemetryReader>>,
    events: Arc<Mutex<VecDeque<Vec<u8>>>>,
    priority_outbound: SyncSender<WirePacket>,
    closing: Arc<AtomicBool>,
) -> Result<JoinHandle<()>> {
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
                        if let Some(memory) = packet
                            .region_offers
                            .into_iter()
                            .next()
                            .map(|offer| offer.memory)
                            && let Ok(reader) = TelemetryReader::map(memory)
                        {
                            if let Ok(mut current) = telemetry.write() {
                                *current = reader;
                            }
                            let request = PriorityRequest {
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
        .map_err(|error| failure("could not start event router thread", error))
}
