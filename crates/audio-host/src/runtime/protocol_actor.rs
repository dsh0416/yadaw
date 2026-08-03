struct ProtocolActorDeps {
    ui_proxy: EventLoopProxy<UiEvent>,
    ui_sender: std_mpsc::SyncSender<ActorRequest>,
    host_event_inbox: std_mpsc::Receiver<HostEvent>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    audio_engine: Arc<engine::AudioEngine>,
    winit_generation: Arc<AtomicU64>,
    runtime_config: RuntimeConfig,
    background_sender: mpsc::Sender<ActorRequest>,
    background_inbox: mpsc::Receiver<ActorRequest>,
}

async fn run_protocol_actor(
    bootstrap: HostBootstrap,
    deps: ProtocolActorDeps,
) -> Result<(), String> {
    const ACTOR_CAPACITY: usize = 64;
    const PROTOCOL_CAPACITY: usize = 256;
    let ProtocolActorDeps {
        ui_proxy,
        ui_sender,
        host_event_inbox,
        processors,
        audio_engine,
        winit_generation,
        runtime_config,
        background_sender,
        background_inbox,
    } = deps;
    let HostBootstrap {
        requests,
        responses,
        priority_requests,
        priority_responses,
        events,
        telemetry_page,
        parameter_ring,
        mapping_commands,
        mapping_events,
        session_epoch,
    } = bootstrap;
    let (telemetry_writer, parameter_consumer, persistent_shared_pages) =
        activate_helper_pages(
            telemetry_page,
            parameter_ring,
            mapping_commands,
            mapping_events,
            session_epoch,
        )?;
    let telemetry = Arc::new(TelemetryPages {
        active: Mutex::new(telemetry_writer),
        pending: Mutex::new(None),
        next_generation: AtomicU64::new(2),
        persistent: persistent_shared_pages,
    });
    let response_leases = Arc::new(Mutex::new(LeaseRegistry::with_session_epoch(session_epoch)));
    let request_arena = Arc::new(Mutex::new(ArenaReceiver::new(session_epoch)));
    let ipc_generation = Arc::new(AtomicU64::new(0));
    let tokio_generation = Arc::new(AtomicU64::new(0));
    let published_event_revision = Arc::new(AtomicU64::new(0));
    let egress_metrics = Arc::new(EgressMetrics::default());
    let host_event_inbox = Arc::new(Mutex::new(host_event_inbox));

    let (outbound, outbound_inbox) = mpsc::channel(PROTOCOL_CAPACITY);
    let (egress_shutdown, egress_shutdown_rx) = watch::channel(false);
    let egress_task = tokio::spawn(run_egress(
        outbound_inbox,
        responses,
        events,
        EgressArenas {
            responses: response_leases.clone(),
            requests: request_arena.clone(),
        },
        runtime_config.egress_concurrency,
        egress_shutdown_rx,
        egress_metrics.clone(),
    ));
    let (inbound, mut inbound_inbox) = mpsc::channel(PROTOCOL_CAPACITY);
    let (priority, mut priority_inbox) = mpsc::channel(64);
    let ingress_thread = spawn_ingress(
        IngressChannels {
            requests,
            priority_requests,
            priority_responses,
        },
        IngressMailboxes {
            inbound,
            priority,
            outbound: outbound.clone(),
        },
        response_leases,
        request_arena.clone(),
        Liveness {
            audio_engine: Arc::clone(&audio_engine),
            ipc: ipc_generation.clone(),
            tokio: tokio_generation.clone(),
            winit: winit_generation,
            egress: egress_metrics,
        },
    )
    .map_err(|error| format!("could not start IPC ingress thread: {error}"))?;

    let handles = Arc::new(Mutex::new(GraphParameterHandles::default()));
    let (engine_sender, engine_inbox) = mpsc::channel(ACTOR_CAPACITY);
    let (vst3_sender, vst3_inbox) = mpsc::channel(ACTOR_CAPACITY);
    let worker_supervisor = WorkerSupervisor::new();
    tokio::spawn(engine_actor(
        engine_inbox,
        handles.clone(),
        Arc::clone(&audio_engine),
    ));
    tokio::task::spawn_local(vst3_actor(
        vst3_inbox,
        Vst3ActorDeps {
            ui_proxy: ui_proxy.clone(),
            ui_sender,
            processors,
            handles,
            request_arena: request_arena.clone(),
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

    outbound
        .send(OutboundMessage::Event(
            encode_event(&HostEvent::Ready, Vec::new()).map_err(|error| error.to_string())?,
        ))
        .await
        .map_err(|_| "audio-host egress stopped before Ready".to_owned())?;

    let telemetry_pages = telemetry.clone();
    let telemetry_outbound = outbound.clone();
    let telemetry_host_events = host_event_inbox.clone();
    let telemetry_event_revision = published_event_revision.clone();
    let telemetry_audio_engine = Arc::clone(&audio_engine);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(33));
        loop {
            interval.tick().await;
            let editor_events = telemetry_host_events
                .lock()
                .map(|inbox| inbox.try_iter().collect::<Vec<_>>())
                .unwrap_or_default();
            for event in editor_events {
                if let Ok(packet) = encode_event(&event, Vec::new()) {
                    let _ = telemetry_outbound
                        .send(OutboundMessage::Event(packet))
                        .await;
                }
            }
            let published_revision = telemetry_audio_engine.published_graph_generation();
            publish_telemetry(
                &telemetry_pages,
                &telemetry_outbound,
                published_revision,
                session_epoch,
                &telemetry_audio_engine,
            )
            .await;
            if published_revision != 0
                && telemetry_event_revision.swap(published_revision, Ordering::AcqRel)
                    != published_revision
                && let Ok(packet) = encode_event(
                    &HostEvent::GraphPublished {
                        revision: published_revision,
                    },
                    Vec::new(),
                )
            {
                let _ = telemetry_outbound
                    .send(OutboundMessage::Event(packet))
                    .await;
            }
        }
    });

    let inflight = Arc::new(Semaphore::new(PROTOCOL_CAPACITY));
    loop {
        tokio::select! {
            inbound = inbound_inbox.recv() => {
                let Some(inbound) = inbound else { break };
                tokio_generation.fetch_add(1, Ordering::Release);
                let permit = match inflight.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let _ = outbound
                            .send(OutboundMessage::Response {
                                value: response(
                                    inbound.request.request_id,
                                    ControlResult::Busy,
                                ),
                                request_leases: inbound.received_leases,
                            })
                            .await;
                        continue;
                    }
                };
                let engine_sender = engine_sender.clone();
                let vst3_sender = vst3_sender.clone();
                let background_sender = background_sender.clone();
                let outbound = outbound.clone();
                let audio_engine = Arc::clone(&audio_engine);
                tokio::spawn(async move {
                    let _permit = permit;
                    let ControlRequest {
                        request_id,
                        command,
                    } = inbound.request;
                    let received_leases = inbound.received_leases;
                    let shutdown = matches!(command, ControlCommand::Shutdown);
                    let deadline = protocol_deadline(&command);
                    let work = async move {
                        if shutdown {
                            let _ = audio_engine.stop_audio_engine();
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
                    let result = match tokio::time::timeout(deadline, work).await {
                        Ok(result) => result,
                        Err(_) => control_error! {
                            message: "audio-host request deadline exceeded".into(),
                        },
                    };
                    let _ = outbound
                        .send(OutboundMessage::Response {
                            value: response(request_id, result),
                            request_leases: received_leases,
                        })
                        .await;
                });
            }
            priority = priority_inbox.recv() => {
                let Some(priority) = priority else { break };
                tokio_generation.fetch_add(1, Ordering::Release);
                match priority {
                    PriorityIngress::ParameterWake => {
                        let mut commands = Vec::new();
                        parameter_consumer.drain(4096, &mut commands);
                        for command in commands {
                            let sender = match command.target_kind {
                                heron_dsp_runtime::protocol::ParameterTargetKind::Plugin => &vst3_sender,
                                _ => &engine_sender,
                            };
                            let _ = dispatch_parameter(sender, command).await;
                        }
                    }
                    PriorityIngress::ParameterBoundary(command) => {
                        let sender = match command.target_kind {
                            heron_dsp_runtime::protocol::ParameterTargetKind::Plugin => &vst3_sender,
                            _ => &engine_sender,
                        };
                        let _ = dispatch_parameter(sender, command).await;
                    }
                    PriorityIngress::Shutdown => {
                        let _ = audio_engine.stop_audio_engine();
                    }
                    PriorityIngress::TelemetryPageReady { epoch, generation } => {
                        let next = telemetry
                            .pending
                            .lock()
                            .ok()
                            .and_then(|mut pending| {
                                let matches = pending.as_ref().is_some_and(|writer| {
                                    writer.epoch() == epoch
                                        && writer.descriptor().generation() == generation
                                        && writer.peer_verified()
                                });
                                matches.then(|| pending.take()).flatten()
                            });
                        if let Some(next) = next {
                            let _ = next.unlink();
                            if let Ok(mut current) = telemetry.active.lock() {
                                *current = next;
                            }
                            if let Ok(packet) = encode_event(
                                &HostEvent::TelemetryPageActive { epoch, generation },
                                Vec::new(),
                            ) {
                                let _ = outbound.send(OutboundMessage::Event(packet)).await;
                            }
                        }
                    }
                }
            }
        }
    }
    // Shutdown is a two-phase handshake: acknowledge the request first, then
    // keep the process alive until the parent closes its IPC senders. The
    // closed ingress mailboxes break the loop and make it safe to stop the UI
    // event loop without racing the final response.
    let _ = ui_proxy.send_event(UiEvent::Exit);
    // The blocking IPC receivers are deliberately detached. Joining them here would
    // deadlock a clean shutdown while the parent still owns channel handles. Process
    // teardown closes those handles after the Tokio actor and winit loop have exited.
    let final_editor_events = host_event_inbox
        .lock()
        .map(|inbox| inbox.try_iter().collect::<Vec<_>>())
        .unwrap_or_default();
    for event in final_editor_events {
        if let Ok(packet) = encode_event(&event, Vec::new()) {
            let _ = outbound.send(OutboundMessage::Event(packet)).await;
        }
    }
    let _ = egress_shutdown.send(true);
    let _ = egress_task.await;
    drop((outbound, ingress_thread));
    Ok(())
}

fn activate_helper_pages(
    telemetry_descriptor: SharedMemoryDescriptor,
    parameter_descriptor: SharedMemoryDescriptor,
    commands: ipc_channel::ipc::IpcReceiver<MappingCommand>,
    events: ipc_channel::ipc::IpcSender<MappingEvent>,
    session_epoch: u64,
) -> Result<(TelemetryWriter, ParameterConsumer, bool), String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    let telemetry_generation = telemetry_descriptor.generation();
    let parameter_generation = parameter_descriptor.generation();
    let opened = TelemetryWriter::open_and_acknowledge(telemetry_descriptor)
        .and_then(|telemetry| {
            ParameterConsumer::open_and_acknowledge(parameter_descriptor)
                .map(|parameters| (telemetry, parameters))
        });
    let (telemetry, parameters) = match opened {
        Ok(values) => values,
        Err(error) => {
            let _ = events.send(MappingEvent::Aborted {
                failure: mapping_failure(&error),
            });
            return fallback_helper_pages(session_epoch);
        }
    };
    events
        .send(MappingEvent::Mapped {
            telemetry_generation,
            parameter_generation,
        })
        .map_err(|_| "mapping event channel closed before Mapped".to_owned())?;
    match commands.try_recv_timeout(TIMEOUT) {
        Ok(MappingCommand::Activate {
            telemetry_generation: received_telemetry,
            parameter_generation: received_parameter,
        }) if received_telemetry == telemetry_generation
            && received_parameter == parameter_generation =>
        {
            events
                .send(MappingEvent::Active {
                    telemetry_generation,
                    parameter_generation,
                })
                .map_err(|_| "mapping event channel closed before Active".to_owned())?;
            Ok((telemetry, parameters, true))
        }
        Ok(MappingCommand::Activate { .. }) => {
            let _ = events.send(MappingEvent::Aborted {
                failure: MappingFailure::Generation,
            });
            fallback_helper_pages(session_epoch)
        }
        Ok(MappingCommand::Abort) => fallback_helper_pages(session_epoch),
        Err(TryRecvError::Empty) => {
            let _ = events.send(MappingEvent::Aborted {
                failure: MappingFailure::Timeout,
            });
            fallback_helper_pages(session_epoch)
        }
        Err(TryRecvError::IpcError(_)) => Err("mapping command channel closed".to_owned()),
    }
}

fn fallback_helper_pages(
    session_epoch: u64,
) -> Result<(TelemetryWriter, ParameterConsumer, bool), String> {
    let telemetry = create_telemetry_page(INITIAL_TELEMETRY_CAPACITY, session_epoch, 1)
        .and_then(TelemetryWriter::map)
        .map_err(|error| error.to_string())?;
    let parameters = create_parameter_ring(session_epoch, 1)
        .and_then(ParameterConsumer::map)
        .map_err(|error| error.to_string())?;
    Ok((telemetry, parameters, false))
}

fn mapping_failure(error: &TransportError) -> MappingFailure {
    match error {
        TransportError::SharedMemory(SharedMemoryError::InvalidDescriptor { .. }) => {
            MappingFailure::Descriptor
        }
        TransportError::SharedMemory(_) => MappingFailure::Open,
        TransportError::InvalidSharedLayout | TransportError::InvalidCapacity => {
            MappingFailure::Layout
        }
        _ => MappingFailure::Challenge,
    }
}
