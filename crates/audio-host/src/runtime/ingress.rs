struct Liveness {
    audio_engine: Arc<engine::AudioEngine>,
    ipc: Arc<AtomicU64>,
    tokio: Arc<AtomicU64>,
    winit: Arc<AtomicU64>,
    egress: Arc<EgressMetrics>,
}

struct IngressChannels {
    requests: ipc_channel::ipc::IpcReceiver<WirePacket>,
    priority_requests: ipc_channel::ipc::IpcReceiver<WirePacket>,
    priority_responses: ipc_channel::ipc::IpcSender<WirePacket>,
}

struct IngressMailboxes {
    inbound: mpsc::Sender<InboundRequest>,
    priority: mpsc::Sender<PriorityIngress>,
    outbound: mpsc::Sender<OutboundMessage>,
}

fn spawn_ingress(
    channels: IngressChannels,
    mailboxes: IngressMailboxes,
    leases: Arc<Mutex<LeaseRegistry>>,
    request_arena: Arc<Mutex<ArenaReceiver>>,
    liveness: Liveness,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("yadaw-ipc-ingress".into())
        .spawn(move || {
            let mut receivers = match ipc_channel::ipc::IpcReceiverSet::new() {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("audio-host: could not create IPC receiver set: {error}");
                    return;
                }
            };
            let normal_id = match receivers.add(channels.requests) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("audio-host: could not register normal IPC receiver: {error}");
                    return;
                }
            };
            let priority_id = match receivers.add(channels.priority_requests) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("audio-host: could not register priority IPC receiver: {error}");
                    return;
                }
            };
            let mut normal_open = true;
            let mut priority_open = true;
            while normal_open || priority_open {
                let mut selected = match receivers.select() {
                    Ok(value) => value,
                    Err(error) => {
                        eprintln!("audio-host: IPC receiver set stopped: {error}");
                        break;
                    }
                };
                // A heartbeat that arrived in the same kernel wake is always handled
                // before ordinary work is offered to Tokio.
                selected.sort_by_key(|selection| match selection {
                    ipc_channel::ipc::IpcSelectionResult::MessageReceived(id, _)
                    | ipc_channel::ipc::IpcSelectionResult::ChannelClosed(id) => {
                        usize::from(*id != priority_id)
                    }
                });
                for selection in selected {
                    let (id, message) = match selection {
                        ipc_channel::ipc::IpcSelectionResult::MessageReceived(id, message) => {
                            (id, message)
                        }
                        ipc_channel::ipc::IpcSelectionResult::ChannelClosed(id) => {
                            if id == normal_id {
                                normal_open = false;
                            } else if id == priority_id {
                                priority_open = false;
                            }
                            continue;
                        }
                    };
                    let packet = match message.to::<WirePacket>() {
                        Ok(value) => value,
                        Err(error) => {
                            eprintln!("audio-host: invalid IPC packet: {error}");
                            continue;
                        }
                    };
                    let ipc_generation = liveness.ipc.fetch_add(1, Ordering::AcqRel) + 1;
                    if id == normal_id {
                        let decoded = request_arena
                            .lock()
                            .map_err(|_| "request arena is poisoned".to_owned())
                            .and_then(|mut arena| {
                                decode_request_deferred(packet, &mut arena)
                                    .map_err(|error| error.to_string())
                            });
                        let (request, received_leases) = match decoded {
                            Ok(value) => value,
                            Err(error) => {
                                eprintln!("audio-host: rejected invalid request packet: {error}");
                                continue;
                            }
                        };
                        let request_id = request.request_id;
                        match mailboxes.inbound.try_send(InboundRequest {
                            request,
                            received_leases,
                        }) {
                            Ok(()) => {}
                            Err(mpsc::error::TrySendError::Full(inbound)) => {
                                let _ = mailboxes.outbound.try_send(OutboundMessage::Response {
                                    value: response(request_id, ControlResult::Busy),
                                    request_leases: inbound.received_leases,
                                });
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => return,
                        }
                        continue;
                    }
                    let request = match decode_body::<PriorityRequest>(&packet.body) {
                        Ok(request) => request,
                        Err(error) => {
                            eprintln!("audio-host: invalid priority request: {error}");
                            continue;
                        }
                    };
                    let mut shutdown_permit = None;
                    let result = match request.command {
                        PriorityCommand::Heartbeat => {
                            let (callback_generation, transport_state) =
                                liveness.audio_engine.heartbeat_snapshot();
                            PriorityResult::Heartbeat {
                                ipc_generation,
                                tokio_generation: liveness.tokio.load(Ordering::Acquire),
                                winit_generation: liveness.winit.load(Ordering::Acquire),
                                callback_generation,
                                transport_state,
                                egress_active: liveness.egress.active.load(Ordering::Acquire),
                                egress_queue_depth: liveness
                                    .egress
                                    .queue_depth
                                    .load(Ordering::Acquire),
                                egress_queue_high_water: liveness
                                    .egress
                                    .queue_high_water
                                    .load(Ordering::Acquire),
                                egress_batches: liveness.egress.batches.load(Ordering::Acquire),
                                blocking_jobs: liveness
                                    .egress
                                    .blocking_jobs
                                    .load(Ordering::Acquire),
                                arena_regions: liveness
                                    .egress
                                    .arena_regions
                                    .load(Ordering::Acquire),
                                arena_capacity_bytes: liveness
                                    .egress
                                    .arena_capacity_bytes
                                    .load(Ordering::Acquire),
                                arena_used_bytes: liveness
                                    .egress
                                    .arena_used_bytes
                                    .load(Ordering::Acquire),
                                arena_high_water_bytes: liveness
                                    .egress
                                    .arena_high_water_bytes
                                    .load(Ordering::Acquire),
                                arena_offers: liveness.egress.arena_offers.load(Ordering::Acquire),
                                arena_busy: liveness.egress.arena_busy.load(Ordering::Acquire),
                                arena_quarantined_regions: liveness
                                    .egress
                                    .arena_quarantined_regions
                                    .load(Ordering::Acquire),
                                arena_copied_bytes: liveness
                                    .egress
                                    .arena_copied_bytes
                                    .load(Ordering::Acquire),
                            }
                        }
                        PriorityCommand::ReleaseLeases { lease_ids } => {
                            if let Ok(mut leases) = leases.lock() {
                                leases.release(&lease_ids);
                            }
                            PriorityResult::Accepted
                        }
                        PriorityCommand::ParameterWake => {
                            match mailboxes.priority.try_send(PriorityIngress::ParameterWake) {
                                Ok(()) => PriorityResult::Accepted,
                                Err(_) => PriorityResult::Busy,
                            }
                        }
                        PriorityCommand::ParameterBoundary { command } => {
                            match mailboxes
                                .priority
                                .try_send(PriorityIngress::ParameterBoundary(command))
                            {
                                Ok(()) => PriorityResult::Accepted,
                                Err(_) => PriorityResult::Busy,
                            }
                        }
                        PriorityCommand::Shutdown => {
                            match mailboxes.priority.try_reserve() {
                                Ok(permit) => {
                                    shutdown_permit = Some(permit);
                                    PriorityResult::Accepted
                                }
                                Err(_) => PriorityResult::Busy,
                            }
                        }
                        PriorityCommand::TelemetryPageReady { epoch, generation } => {
                            match mailboxes
                                .priority
                                .try_send(PriorityIngress::TelemetryPageReady { epoch, generation })
                            {
                                Ok(()) => PriorityResult::Accepted,
                                Err(_) => PriorityResult::Busy,
                            }
                        }
                    };
                    let reply = PriorityResponse {
                        request_id: request.request_id,
                        result,
                    };
                    let packet = match encode_priority(&reply) {
                        Ok(packet) => packet,
                        Err(error) => {
                            eprintln!("audio-host: could not encode priority response: {error}");
                            continue;
                        }
                    };
                    if let Err(error) = channels.priority_responses.send(packet) {
                        if let Some(permit) = shutdown_permit {
                            permit.send(PriorityIngress::Shutdown);
                        }
                        eprintln!("audio-host: priority response failed: {error}");
                        return;
                    }
                    // Keep shutdown invisible to the protocol actor until the
                    // acknowledgement is in the IPC channel. Otherwise the UI
                    // event loop can terminate the process before the parent
                    // observes the accepted response.
                    if let Some(permit) = shutdown_permit {
                        permit.send(PriorityIngress::Shutdown);
                    }
                }
            }
        })
}
