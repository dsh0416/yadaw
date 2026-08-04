use super::*;

#[test]
fn runtime_config_validates_each_bound_and_cross_field_constraint() {
    assert!(RuntimeConfig::auto().validate().is_ok());
    assert!(
        RuntimeConfig {
            worker_threads: 1,
            max_blocking_threads: 2,
            egress_concurrency: 1,
        }
        .validate()
        .is_ok()
    );
    for invalid in [
        RuntimeConfig {
            worker_threads: 0,
            max_blocking_threads: 2,
            egress_concurrency: 1,
        },
        RuntimeConfig {
            worker_threads: 9,
            max_blocking_threads: 2,
            egress_concurrency: 1,
        },
        RuntimeConfig {
            worker_threads: 1,
            max_blocking_threads: 1,
            egress_concurrency: 1,
        },
        RuntimeConfig {
            worker_threads: 1,
            max_blocking_threads: 17,
            egress_concurrency: 1,
        },
        RuntimeConfig {
            worker_threads: 1,
            max_blocking_threads: 2,
            egress_concurrency: 0,
        },
        RuntimeConfig {
            worker_threads: 1,
            max_blocking_threads: 2,
            egress_concurrency: 3,
        },
    ] {
        assert!(invalid.validate().is_err(), "{invalid:?}");
    }
}

#[test]
fn protocol_routing_classifies_commands_and_deadlines_by_owner() {
    assert!(is_vst3_command(&ControlCommand::Ping));
    assert!(is_vst3_command(&ControlCommand::PluginParameters {
        instance_id: "plugin".into(),
    }));
    assert!(!is_vst3_command(&ControlCommand::AudioEngineSnapshot));
    assert!(is_background_io_command(&ControlCommand::ListAudioBackends));
    assert!(is_background_io_command(
        &ControlCommand::ListAudioDevices {
            backend: "mock".into(),
        }
    ));
    assert!(!is_background_io_command(&ControlCommand::Ping));
    assert_eq!(
        protocol_deadline(&ControlCommand::RunAudioBenchmark {
            plugin_instance_ids: Vec::new(),
        }),
        Duration::from_secs(60)
    );
    assert_eq!(
        protocol_deadline(&ControlCommand::OpenPluginEditor {
            instance_id: "plugin".into(),
            preference: PluginEditorPreference::default(),
            context: PluginEditorContext::default(),
        }),
        Duration::from_secs(15)
    );
    assert_eq!(
        protocol_deadline(&ControlCommand::AudioEngineSnapshot),
        Duration::from_secs(2)
    );
}

#[test]
fn deferred_binary_accepts_inline_and_rejects_unresolved_attachment() {
    let arena = Arc::new(Mutex::new(ArenaReceiver::new(1)));
    let inline = resolve_deferred_binary(BinaryPayload::inline(vec![1, 2, 3]), &arena)
        .expect("inline binary");
    assert_eq!(inline.as_slice(), [1, 2, 3]);

    let error = match resolve_deferred_binary(
        BinaryPayload::Attachment {
            index: 0,
            offset: 0,
            length: 3,
        },
        &arena,
    ) {
        Ok(_) => panic!("attachment should be materialized before the actor"),
        Err(error) => error,
    };
    assert!(error.contains("Node attachment"));
}

#[test]
fn telemetry_transport_state_codes_are_stable() {
    assert_eq!(transport_state_code("stopped"), 0);
    assert_eq!(transport_state_code("playing"), 1);
    assert_eq!(transport_state_code("recording"), 2);
    assert_eq!(transport_state_code("waiting"), 3);
    assert_eq!(transport_state_code("counting-in"), 4);
    assert_eq!(transport_state_code("future-state"), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn actor_dispatch_reports_closed_sender_and_dropped_response() {
    let (closed_sender, closed_inbox) = mpsc::channel(1);
    drop(closed_inbox);
    assert!(matches!(
        dispatch_actor_command(&closed_sender, ActorCommand::Control(ControlCommand::Ping))
            .await,
        ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
    ));

    let (dropped_sender, mut dropped_inbox) = mpsc::channel::<ActorRequest>(1);
    let dropper = tokio::spawn(async move {
        let request = dropped_inbox.recv().await.expect("actor request");
        drop(request.reply);
    });
    assert!(matches!(
        dispatch_actor_command(&dropped_sender, ActorCommand::Control(ControlCommand::Ping))
            .await,
        ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
    ));
    dropper.await.expect("dropper task");
}

#[tokio::test(flavor = "current_thread")]
async fn engine_and_background_actors_enforce_command_ownership() {
    use heron_dsp_runtime::protocol::ParameterTargetKind;
    let audio_engine = Arc::new(engine::AudioEngine::new());
    let handles = Arc::new(Mutex::new(GraphParameterHandles::default()));
    let (engine_sender, engine_inbox) = mpsc::channel(4);
    let engine_task = tokio::spawn(engine_actor(
        engine_inbox,
        Arc::clone(&handles),
        Arc::clone(&audio_engine),
    ));
    assert!(matches!(
        dispatch_actor_command(
            &engine_sender,
            ActorCommand::SyncAraGraph {
                graph: Some(empty_live_graph()),
            },
        )
        .await,
        ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
    ));
    assert!(matches!(
        dispatch_actor_command(
            &engine_sender,
            ActorCommand::BuildGraph {
                graph: minimal_native_graph(1),
            },
        )
        .await,
        ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
    ));
    assert!(matches!(
        dispatch_actor_command(
            &engine_sender,
            ActorCommand::Parameter(parameter_command(ParameterTargetKind::Plugin, 1, 0, 0.5)),
        )
        .await,
        ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
    ));
    drop(engine_sender);
    engine_task.await.expect("engine actor task");

    let (unused_engine_sender, unused_engine_inbox) = mpsc::channel(1);
    drop(unused_engine_inbox);
    let (background_sender, background_inbox) = mpsc::channel(4);
    let background_task = tokio::spawn(background_io_actor(
        background_inbox,
        unused_engine_sender,
        WorkerSupervisor::new(),
        audio_engine,
    ));
    assert!(matches!(
        dispatch_actor_command(
            &background_sender,
            ActorCommand::Parameter(parameter_command(
                ParameterTargetKind::MixerChannel,
                1,
                0,
                0.5,
            )),
        )
        .await,
        ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
    ));
    assert!(matches!(
        dispatch_actor_command(
            &background_sender,
            ActorCommand::SyncAraGraph { graph: None },
        )
        .await,
        ControlResult::Error { error } if error.code == RpcErrorCode::InvariantViolation
    ));
    drop(background_sender);
    background_task.await.expect("background actor task");
}

#[tokio::test(flavor = "current_thread")]
async fn ingress_forwards_normal_requests_and_reports_a_full_mailbox() {
    let mut ingress = TestIngress::new(1);
    ingress.send_request(ControlRequest {
        request_id: 1,
        command: ControlCommand::Ping,
    });
    let received = tokio::time::timeout(Duration::from_secs(2), ingress.inbound.recv())
        .await
        .expect("normal ingress timeout")
        .expect("normal ingress request");
    assert_eq!(received.request.request_id, 1);
    assert!(matches!(received.request.command, ControlCommand::Ping));
    assert!(received.received_leases.is_empty());

    ingress
        .inbound_sender
        .try_send(InboundRequest {
            request: ControlRequest {
                request_id: 99,
                command: ControlCommand::Ping,
            },
            received_leases: Vec::new(),
        })
        .expect("fill inbound mailbox");
    ingress.send_request(ControlRequest {
        request_id: 2,
        command: ControlCommand::Ping,
    });
    let busy = tokio::time::timeout(Duration::from_secs(2), ingress.outbound.recv())
        .await
        .expect("busy response timeout")
        .expect("busy response");
    assert!(matches!(
        busy,
        OutboundMessage::Response {
            value: ControlResponse {
                request_id: 2,
                result: ControlResult::Busy,
            },
            request_leases,
        } if request_leases.is_empty()
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn priority_ingress_handles_heartbeat_busy_and_acknowledged_shutdown() {
    let mut ingress = TestIngress::new(1);
    ingress.send_priority(PriorityRequest {
        request_id: 1,
        command: PriorityCommand::Heartbeat,
    });
    assert!(matches!(
        ingress.receive_priority_response(),
        PriorityResponse {
            request_id: 1,
            result: PriorityResult::Heartbeat {
                ipc_generation: 1,
                ..
            },
        }
    ));

    ingress
        .priority_sender
        .try_send(PriorityIngress::ParameterWake)
        .expect("fill priority mailbox");
    ingress.send_priority(PriorityRequest {
        request_id: 2,
        command: PriorityCommand::ParameterWake,
    });
    assert_eq!(
        ingress.receive_priority_response(),
        PriorityResponse {
            request_id: 2,
            result: PriorityResult::Busy,
        }
    );
    assert!(matches!(
        ingress.priority.try_recv(),
        Ok(PriorityIngress::ParameterWake)
    ));

    ingress.send_priority(PriorityRequest {
        request_id: 3,
        command: PriorityCommand::Shutdown,
    });
    assert_eq!(
        ingress.receive_priority_response(),
        PriorityResponse {
            request_id: 3,
            result: PriorityResult::Accepted,
        }
    );
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), ingress.priority.recv())
            .await
            .expect("shutdown notification timeout"),
        Some(PriorityIngress::Shutdown)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn egress_sends_responses_release_events_and_drains_on_shutdown() {
    let (response_sender, responses) = ipc::channel().expect("response IPC channel");
    let responses = Arc::new(Mutex::new(responses));
    let (event_sender, events) = ipc::channel().expect("event IPC channel");
    let events = Arc::new(Mutex::new(events));
    let (outbound, outbound_inbox) = mpsc::channel(4);
    let (shutdown, shutdown_rx) = watch::channel(false);
    let metrics = Arc::new(EgressMetrics::default());
    let task = tokio::spawn(run_egress(
        outbound_inbox,
        response_sender,
        event_sender,
        EgressArenas {
            responses: Arc::new(Mutex::new(LeaseRegistry::with_session_epoch(1))),
            requests: Arc::new(Mutex::new(ArenaReceiver::new(1))),
        },
        1,
        shutdown_rx,
        Arc::clone(&metrics),
    ));
    outbound
        .send(OutboundMessage::Response {
            value: ControlResponse {
                request_id: 7,
                result: ControlResult::Accepted,
            },
            request_leases: vec![11],
        })
        .await
        .expect("queue response");
    let mut response_arena = ArenaReceiver::new(1);
    let (response, attachments, release) = heron_ipc_transport::decode_response_to_attachments(
        receive_ipc_packet(Arc::clone(&responses)).await,
        &mut response_arena,
    )
    .expect("decode egress response");
    assert_eq!(response.request_id, 7);
    assert_eq!(response.result, ControlResult::Accepted);
    assert!(attachments.is_empty());
    assert!(release.is_empty());
    let release_event = receive_ipc_packet(Arc::clone(&events)).await;
    assert_eq!(
        decode_body::<HostEvent>(&release_event.body).expect("decode release event"),
        HostEvent::ReleaseLeases {
            lease_ids: vec![11],
        }
    );

    outbound
        .send(OutboundMessage::Event(
            encode_event(&HostEvent::GraphPublished { revision: 4 }, Vec::new())
                .expect("encode host event"),
        ))
        .await
        .expect("queue host event");
    let event = receive_ipc_packet(Arc::clone(&events)).await;
    assert_eq!(
        decode_body::<HostEvent>(&event.body).expect("decode host event"),
        HostEvent::GraphPublished { revision: 4 }
    );

    outbound
        .try_send(OutboundMessage::Response {
            value: ControlResponse {
                request_id: 8,
                result: ControlResult::Pong,
            },
            request_leases: Vec::new(),
        })
        .expect("queue response for shutdown drain");
    shutdown.send(true).expect("signal egress shutdown");
    let (drained, _, _) = heron_ipc_transport::decode_response_to_attachments(
        receive_ipc_packet(responses).await,
        &mut response_arena,
    )
    .expect("decode drained response");
    assert_eq!(drained.request_id, 8);
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("egress task timeout")
        .expect("egress task");
    assert_eq!(metrics.active.load(Ordering::Acquire), 0);
    assert_eq!(metrics.blocking_jobs.load(Ordering::Acquire), 0);
    assert_eq!(metrics.queue_depth.load(Ordering::Acquire), 0);
    assert!(metrics.batches.load(Ordering::Relaxed) >= 3);
}
