enum DeferredBinary {
    Inline(Vec<u8>),
    Shared(ResolvedBlob),
}

impl DeferredBinary {
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Inline(bytes) => bytes,
            Self::Shared(blob) => blob.as_slice(),
        }
    }
}

fn resolve_deferred_binary(
    payload: BinaryPayload,
    arena: &Arc<Mutex<ArenaReceiver>>,
) -> Result<DeferredBinary, String> {
    match payload {
        BinaryPayload::Inline { bytes } => Ok(DeferredBinary::Inline(bytes)),
        BinaryPayload::Shared { reference } => arena
            .lock()
            .map_err(|_| "request arena is poisoned".to_owned())?
            .acquire(reference)
            .map(DeferredBinary::Shared)
            .map_err(|error| error.to_string()),
        BinaryPayload::Attachment { .. } => {
            Err("VST3 state still references a Node attachment".to_owned())
        }
    }
}

fn update_graph_midi_routes(graph: &LiveMixerGraph) {
    let Some(midi_input) = MIDI_INPUT.get() else {
        return;
    };
    let mut all_inputs = false;
    let port_ids = graph
        .channels
        .iter()
        .filter(|channel| {
            channel.kind == "instrument"
                && channel.system_role.is_none()
                && (channel.input_monitoring || channel.record_armed)
        })
        .filter_map(|channel| {
            if let Some(port_id) = &channel.midi_input_port_id {
                Some(port_id.clone())
            } else {
                all_inputs = true;
                None
            }
        })
        .collect();
    midi_input.update_routes(all_inputs, port_ids);
}

fn log_graph_transaction_failure(meta: &RpcRequestMeta, phase: &str, error: &dyn std::fmt::Display) {
    eprintln!(
        "audio-host graph transaction [{}] {phase} failed: {error}",
        graph_correlation(meta, phase)
    );
}

struct Vst3ActorDeps {
    ui_proxy: EventLoopProxy<UiEvent>,
    ui_sender: std_mpsc::SyncSender<ActorRequest>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    handles: Arc<Mutex<GraphParameterHandles>>,
    request_arena: Arc<Mutex<ArenaReceiver>>,
    background_sender: mpsc::Sender<ActorRequest>,
    engine_sender: mpsc::Sender<ActorRequest>,
    session_epoch: u64,
}

async fn vst3_actor(mut inbox: mpsc::Receiver<ActorRequest>, deps: Vst3ActorDeps) {
    let Vst3ActorDeps {
        ui_proxy,
        ui_sender,
        processors,
        handles,
        request_arena,
        background_sender,
        engine_sender,
        session_epoch,
    } = deps;
    let mut graph_revision = 0_u64;
    let mut graph_snapshot: Option<LiveMixerGraph> = None;
    let mut graph_transactions = GraphTransactionState::new(session_epoch);
    while let Some(message) = inbox.recv().await {
        let result = match message.command {
            ActorCommand::BuildGraph { .. } | ActorCommand::PublishBuiltGraph { .. } => {
                ControlResult::Error {
                    message: "VST3 actor does not own graph worker jobs".into(),
                }
            }
            ActorCommand::SyncAraGraph { graph } => {
                forward_to_ui(
                    &ui_sender,
                    &ui_proxy,
                    ActorRequest {
                        command: ActorCommand::SyncAraGraph { graph },
                        reply: message.reply,
                    },
                )
                .await;
                continue;
            }
            ActorCommand::Parameter(command) => {
                forward_to_ui(
                    &ui_sender,
                    &ui_proxy,
                    ActorRequest {
                        command: ActorCommand::Parameter(command),
                        reply: message.reply,
                    },
                )
                .await;
                continue;
            }
            ActorCommand::Control(command) => match command {
                ControlCommand::Ping => {
                    forward_to_ui(
                        &ui_sender,
                        &ui_proxy,
                        ActorRequest {
                            command: ActorCommand::Control(ControlCommand::Ping),
                            reply: message.reply,
                        },
                    )
                    .await;
                    continue;
                }
                ControlCommand::LoadPlugin {
                    instance_id,
                    module_path,
                    class_id,
                    plugin_kind,
                    audio_mode,
                    sample_rate,
                    component_state,
                    controller_state,
                    ara_factory_class_id,
                    ara_document_state,
                } => {
                    let component_state = resolve_deferred_binary(component_state, &request_arena);
                    let controller_state =
                        resolve_deferred_binary(controller_state, &request_arena);
                    let ara_document_state =
                        resolve_deferred_binary(ara_document_state, &request_arena);
                    match (component_state, controller_state, ara_document_state) {
                        (Ok(component_state), Ok(controller_state), Ok(ara_document_state)) => {
                            forward_to_ui(
                                &ui_sender,
                                &ui_proxy,
                                ActorRequest {
                                    command: ActorCommand::Control(ControlCommand::LoadPlugin {
                                        instance_id,
                                        module_path,
                                        class_id,
                                        plugin_kind,
                                        audio_mode,
                                        sample_rate,
                                        component_state: BinaryPayload::inline(
                                            component_state.as_slice().to_vec(),
                                        ),
                                        controller_state: BinaryPayload::inline(
                                            controller_state.as_slice().to_vec(),
                                        ),
                                        ara_factory_class_id,
                                        ara_document_state: BinaryPayload::inline(
                                            ara_document_state.as_slice().to_vec(),
                                        ),
                                    }),
                                    reply: message.reply,
                                },
                            )
                            .await;
                            continue;
                        }
                        (Err(message), _, _)
                        | (_, Err(message), _)
                        | (_, _, Err(message)) => ControlResult::Error { message },
                    }
                }
                command @ (ControlCommand::UnloadPlugin { .. }
                | ControlCommand::PluginParameters { .. }
                | ControlCommand::SetPluginParameter { .. }
                | ControlCommand::SavePluginState { .. }
                | ControlCommand::OpenPluginEditor { .. }
                | ControlCommand::ClosePluginEditor { .. }) => {
                    forward_to_ui(
                        &ui_sender,
                        &ui_proxy,
                        ActorRequest {
                            command: ActorCommand::Control(command),
                            reply: message.reply,
                        },
                    )
                    .await;
                    continue;
                }
                ControlCommand::PrepareGraph { meta, request } => {
                    let transaction_request = GraphTransactionRequest {
                        helper_epoch: request.helper_epoch.clone(),
                        project_graph: request.project_graph.clone(),
                        base_revision: request.base_revision,
                    };
                    let validated = match validate_graph_request(
                        &meta,
                        &transaction_request,
                        &graph_transactions.helper_epoch,
                        graph_transactions.committed_revision,
                    ) {
                        Ok(validated) => validated,
                        Err(error) => {
                            let _ = message.reply.send(graph_failure(&meta, error));
                            continue;
                        }
                    };
                    let Some(operation_id) = validated.operation_id else {
                        let _ = message
                            .reply
                            .send(graph_failure(&meta, graph_validation_error(&meta, "mutation")));
                        continue;
                    };
                    graph_transactions.observe_engine(validated.engine);
                    if request.graph_revision <= request.base_revision {
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_validation_error(&meta, "graphRevision"),
                        ));
                        continue;
                    }
                    if let Some(candidate) = graph_transactions.candidate.as_ref() {
                        let result = if candidate.operation_id == operation_id
                            && candidate.project_graph == request.project_graph
                            && candidate.base_revision == request.base_revision
                            && candidate.graph_revision == request.graph_revision
                        {
                            graph_success(
                                &meta,
                                candidate.graph_revision,
                                GraphTransactionValue::Prepared {
                                    snapshot: graph_transactions.snapshot(),
                                },
                            )
                        } else {
                            graph_failure(
                                &meta,
                                graph_busy_error(
                                    &meta,
                                    Some(candidate.operation_id.clone()),
                                ),
                            )
                        };
                        let _ = message.reply.send(result);
                        continue;
                    }

                    let mut graph = request.graph;
                    let native = (|| {
                        let arena = request_arena
                            .lock()
                            .map_err(|_| "request arena is poisoned".to_owned())?
                            .clone();
                        let processors = processors
                            .lock()
                            .map_err(|_| "VST3 processor registry is poisoned".to_owned())?
                            .clone();
                        materialize_mixer_graph(&mut graph, &arena)
                            .map_err(|error| error.to_string())?;
                        live_graph(
                            request.graph_revision,
                            &graph,
                            Some(&processors),
                            &arena,
                        )
                    })();
                    let native = match native {
                        Ok(native) => native,
                        Err(error) => {
                            log_graph_transaction_failure(&meta, "materialize", &error);
                            let _ = message.reply.send(graph_failure(
                                &meta,
                                graph_dependency_error(&meta, request.project_graph),
                            ));
                            continue;
                        }
                    };
                    let input = match engine::begin_graph_build(native) {
                        Ok(input) => input,
                        Err(error) => {
                            log_graph_transaction_failure(&meta, "begin", &error);
                            let _ = message.reply.send(graph_failure(
                                &meta,
                                graph_dependency_error(&meta, request.project_graph),
                            ));
                            continue;
                        }
                    };
                    let built = match tokio::task::spawn_blocking(move || {
                        engine::compile_graph_build(input)
                    })
                    .await
                    {
                        Ok(Ok(built)) => built,
                        Ok(Err(error)) => {
                            log_graph_transaction_failure(&meta, "compile", &error);
                            let _ = message.reply.send(graph_failure(
                                &meta,
                                graph_dependency_error(&meta, request.project_graph),
                            ));
                            continue;
                        }
                        Err(error) => {
                            log_graph_transaction_failure(&meta, "compile-worker", &error);
                            let _ = message.reply.send(graph_failure(
                                &meta,
                                graph_dependency_error(&meta, request.project_graph),
                            ));
                            continue;
                        }
                    };
                    graph_transactions.prepare(PreparedGraphCandidate {
                        operation_id,
                        project_graph: request.project_graph,
                        base_revision: request.base_revision,
                        graph_revision: request.graph_revision,
                        graph,
                        built,
                    });
                    graph_success(
                        &meta,
                        request.graph_revision,
                        GraphTransactionValue::Prepared {
                            snapshot: graph_transactions.snapshot(),
                        },
                    )
                }
                ControlCommand::ActivateGraph { meta, request } => {
                    let validated = match validate_graph_request(
                        &meta,
                        &request,
                        &graph_transactions.helper_epoch,
                        graph_transactions.committed_revision,
                    ) {
                        Ok(validated) => validated,
                        Err(error) => {
                            let _ = message.reply.send(graph_failure(&meta, error));
                            continue;
                        }
                    };
                    let Some(operation_id) = validated.operation_id else {
                        let _ = message
                            .reply
                            .send(graph_failure(&meta, graph_validation_error(&meta, "mutation")));
                        continue;
                    };
                    graph_transactions.observe_engine(validated.engine);
                    if let Some(candidate) = graph_transactions.candidate.as_ref()
                        && candidate.operation_id != operation_id
                    {
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_busy_error(&meta, Some(candidate.operation_id.clone())),
                        ));
                        continue;
                    }
                    let Some(candidate) = graph_transactions.take_candidate(&operation_id) else {
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_stale_error(
                                &meta,
                                request.project_graph,
                                yadaw_dsp_runtime::protocol::RpcStaleReason::Missing,
                            ),
                        ));
                        continue;
                    };
                    if candidate.project_graph != request.project_graph
                        || candidate.base_revision != request.base_revision
                    {
                        graph_transactions.restore_candidate(candidate);
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_validation_error(&meta, "projectGraph"),
                        ));
                        continue;
                    }

                    let previous_graph = graph_snapshot.clone();
                    let ara_result = dispatch_ui_actor_command(
                        &ui_sender,
                        &ui_proxy,
                        ActorCommand::SyncAraGraph {
                            graph: Some(candidate.graph.clone()),
                        },
                    )
                    .await;
                    if let ControlResult::Error { message: error } = ara_result {
                        log_graph_transaction_failure(&meta, "ara", &error);
                        let _ = dispatch_ui_actor_command(
                            &ui_sender,
                            &ui_proxy,
                            ActorCommand::SyncAraGraph {
                                graph: previous_graph,
                            },
                        )
                        .await;
                        let dependency = candidate.project_graph.clone();
                        graph_transactions.restore_candidate(candidate);
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_dependency_error(&meta, dependency),
                        ));
                        continue;
                    }

                    let PreparedGraphCandidate {
                        operation_id,
                        project_graph,
                        graph_revision: candidate_revision,
                        graph,
                        built,
                        ..
                    } = candidate;
                    match publish_built_graph(&engine_sender, built).await {
                        ControlResult::Accepted => {
                            update_graph_midi_routes(&graph);
                            refresh_graph_handles(&handles, &graph);
                            graph_revision = candidate_revision;
                            graph_snapshot = Some(graph);
                            graph_transactions.commit(
                                operation_id,
                                project_graph,
                                candidate_revision,
                            );
                            if wait_for_graph_publication(candidate_revision).await {
                                graph_success(
                                    &meta,
                                    candidate_revision,
                                    GraphTransactionValue::Activated {
                                        snapshot: graph_transactions.snapshot(),
                                    },
                                )
                            } else {
                                graph_failure(&meta, graph_timeout_error(&meta))
                            }
                        }
                        ControlResult::Error { message: error } => {
                            log_graph_transaction_failure(&meta, "publish", &error);
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::SyncAraGraph {
                                    graph: previous_graph,
                                },
                            )
                            .await;
                            graph_transactions.finish_not_committed(
                                operation_id,
                                candidate_revision,
                            );
                            if error == "graph build superseded" {
                                graph_failure(
                                    &meta,
                                    graph_conflict_error(
                                        &meta,
                                        candidate_revision,
                                        engine::published_graph_generation(),
                                    ),
                                )
                            } else {
                                graph_failure(
                                    &meta,
                                    graph_dependency_error(&meta, request.project_graph),
                                )
                            }
                        }
                        other => {
                            let _ = other;
                            log_graph_transaction_failure(
                                &meta,
                                "publish-result",
                                &"unexpected engine actor result",
                            );
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::SyncAraGraph {
                                    graph: previous_graph,
                                },
                            )
                            .await;
                            graph_transactions.finish_not_committed(
                                operation_id,
                                candidate_revision,
                            );
                            graph_failure(
                                &meta,
                                graph_dependency_error(&meta, request.project_graph),
                            )
                        }
                    }
                }
                ControlCommand::AbortGraph { meta, request } => {
                    let validated = match validate_graph_request(
                        &meta,
                        &request,
                        &graph_transactions.helper_epoch,
                        graph_transactions.committed_revision,
                    ) {
                        Ok(validated) => validated,
                        Err(error) => {
                            let _ = message.reply.send(graph_failure(&meta, error));
                            continue;
                        }
                    };
                    let Some(operation_id) = validated.operation_id else {
                        let _ = message
                            .reply
                            .send(graph_failure(&meta, graph_validation_error(&meta, "mutation")));
                        continue;
                    };
                    graph_transactions.observe_engine(validated.engine);
                    let existed = graph_transactions.abort(&operation_id);
                    graph_success(
                        &meta,
                        graph_transactions.committed_revision,
                        GraphTransactionValue::Aborted {
                            operation_id,
                            existed,
                            snapshot: graph_transactions.snapshot(),
                        },
                    )
                }
                ControlCommand::GraphDeploymentSnapshot { meta } => {
                    match validate_graph_meta(&meta, &graph_transactions.helper_epoch, false) {
                        Ok(validated) => {
                            graph_transactions.observe_engine(validated.engine);
                            graph_success(
                                &meta,
                                graph_transactions.committed_revision,
                                GraphTransactionValue::Snapshot {
                                    snapshot: graph_transactions.snapshot(),
                                },
                            )
                        }
                        Err(error) => graph_failure(&meta, error),
                    }
                }
                ControlCommand::UpdateGraph { update } => {
                    let (revision, mut candidate) = match update {
                        GraphUpdate::Replace { revision, graph } => (revision, graph),
                        GraphUpdate::Patch {
                            base_revision,
                            revision,
                            ops,
                        } => {
                            if base_revision != graph_revision {
                                let _ = message.reply.send(ControlResult::RevisionMismatch {
                                    current_revision: graph_revision,
                                });
                                continue;
                            }
                            let Some(mut graph) = graph_snapshot.clone() else {
                                let _ = message.reply.send(ControlResult::RevisionMismatch {
                                    current_revision: graph_revision,
                                });
                                continue;
                            };
                            graph.apply_ops(ops);
                            (revision, graph)
                        }
                    };
                    let prepared = (|| {
                        let arena = request_arena
                            .lock()
                            .map_err(|_| "request arena is poisoned".to_owned())?
                            .clone();
                        let processors = processors
                            .lock()
                            .map_err(|_| "VST3 processor registry is poisoned".to_owned())?
                            .clone();
                        materialize_mixer_graph(&mut candidate, &arena)
                            .map_err(|error| error.to_string())?;
                        let graph = live_graph(revision, &candidate, Some(&processors), &arena)?;
                        Ok::<_, String>((graph, candidate))
                    })();
                    match prepared {
                        Err(message) => ControlResult::Error { message },
                        Ok((graph, candidate)) => {
                            let previous_graph = graph_snapshot.clone();
                            let ara_result = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::SyncAraGraph {
                                    graph: Some(candidate.clone()),
                                },
                            )
                            .await;
                            if let ControlResult::Error { .. } = ara_result {
                                ara_result
                            } else {
                                match dispatch_build_graph(&background_sender, graph).await {
                                ControlResult::GraphAccepted {
                                    revision: accepted_revision,
                                } => {
                                    update_graph_midi_routes(&candidate);
                                    refresh_graph_handles(&handles, &candidate);
                                    graph_revision = accepted_revision;
                                    graph_snapshot = Some(candidate);
                                    graph_transactions.observe_legacy_commit(accepted_revision);
                                    ControlResult::GraphAccepted {
                                        revision: accepted_revision,
                                    }
                                }
                                other => {
                                    let _ = dispatch_ui_actor_command(
                                        &ui_sender,
                                        &ui_proxy,
                                        ActorCommand::SyncAraGraph {
                                            graph: previous_graph,
                                        },
                                    )
                                    .await;
                                    other
                                }
                            }
                            }
                        }
                    }
                }
                ControlCommand::RunAudioBenchmark {
                    plugin_instance_ids,
                } => {
                    let processors = processors
                        .lock()
                        .map_err(|_| "VST3 processor registry is poisoned".to_owned())
                        .and_then(|processors| {
                            plugin_instance_ids
                                .iter()
                                .map(|instance_id| {
                                    processors
                                        .get(instance_id)
                                        .cloned()
                                        .map(|processor| (instance_id.clone(), processor))
                                        .ok_or_else(|| {
                                            format!(
                                                "audio benchmark VST3 instance `{instance_id}` is not loaded"
                                            )
                                        })
                                })
                                .collect::<Result<Vec<_>, _>>()
                        });
                    match processors {
                        Err(message) => ControlResult::Error { message },
                        Ok(processors) => {
                            match tokio::task::spawn_blocking(move || {
                                engine::run_audio_benchmark(processors)
                            })
                            .await
                            {
                                Ok(Ok(report)) => ControlResult::AudioBenchmark { report },
                                Ok(Err(message)) => ControlResult::Error { message },
                                Err(error) => ControlResult::Error {
                                    message: format!(
                                        "audio benchmark worker did not complete: {error}"
                                    ),
                                },
                            }
                        }
                    }
                }
                _ => ControlResult::Error {
                    message: "unsupported VST3 actor command".into(),
                },
            },
        };
        let _ = message.reply.send(result);
    }
}

async fn dispatch_ui_actor_command(
    sender: &std_mpsc::SyncSender<ActorRequest>,
    proxy: &EventLoopProxy<UiEvent>,
    command: ActorCommand,
) -> ControlResult {
    let (reply, response) = oneshot::channel();
    forward_to_ui(
        sender,
        proxy,
        ActorRequest {
            command,
            reply,
        },
    )
    .await;
    response.await.unwrap_or(ControlResult::Error {
        message: "winit VST3 UI actor dropped its response".into(),
    })
}

async fn dispatch_actor(
    sender: &mpsc::Sender<ActorRequest>,
    command: ControlCommand,
) -> ControlResult {
    let (reply, response) = oneshot::channel();
    if sender
        .send(ActorRequest {
            command: ActorCommand::Control(command),
            reply,
        })
        .await
        .is_err()
    {
        return ControlResult::Error {
            message: "audio-host actor stopped".into(),
        };
    }
    response.await.unwrap_or(ControlResult::Error {
        message: "audio-host actor dropped its response".into(),
    })
}

async fn dispatch_parameter(
    sender: &mpsc::Sender<ActorRequest>,
    command: yadaw_dsp_runtime::protocol::ParameterCommand,
) -> ControlResult {
    let (reply, response) = oneshot::channel();
    if sender
        .send(ActorRequest {
            command: ActorCommand::Parameter(command),
            reply,
        })
        .await
        .is_err()
    {
        return ControlResult::Error {
            message: "audio-host parameter actor stopped".into(),
        };
    }
    response.await.unwrap_or(ControlResult::Error {
        message: "audio-host parameter actor dropped its response".into(),
    })
}

fn is_vst3_command(command: &ControlCommand) -> bool {
    matches!(
        command,
        ControlCommand::Ping
            | ControlCommand::UpdateGraph { .. }
            | ControlCommand::PrepareGraph { .. }
            | ControlCommand::ActivateGraph { .. }
            | ControlCommand::AbortGraph { .. }
            | ControlCommand::GraphDeploymentSnapshot { .. }
            | ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::PluginParameters { .. }
            | ControlCommand::SetPluginParameter { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ClosePluginEditor { .. }
            | ControlCommand::RunAudioBenchmark { .. }
    )
}

fn is_background_io_command(command: &ControlCommand) -> bool {
    matches!(
        command,
        ControlCommand::ListAudioBackends | ControlCommand::ListAudioDevices { .. }
    )
}

fn protocol_deadline(command: &ControlCommand) -> std::time::Duration {
    // The audio benchmark builds three dense mixer graphs around up to 64 live
    // VST3 instances; on slow machines that legitimately exceeds the extended
    // 15 s command deadline, so give it its own generous budget.
    if matches!(command, ControlCommand::RunAudioBenchmark { .. }) {
        std::time::Duration::from_secs(60)
    } else if matches!(
        command,
        ControlCommand::UpdateGraph { .. }
            | ControlCommand::PrepareGraph { .. }
            | ControlCommand::ActivateGraph { .. }
            | ControlCommand::AbortGraph { .. }
            | ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ClosePluginEditor { .. }
            | ControlCommand::BenchmarkEcho { .. }
    ) {
        std::time::Duration::from_secs(15)
    } else {
        std::time::Duration::from_secs(2)
    }
}
