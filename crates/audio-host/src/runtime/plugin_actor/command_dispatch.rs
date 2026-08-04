use super::graph_deployment::{log_graph_transaction_failure, update_graph_midi_routes};
use super::loading::resolve_deferred_binary;
use super::{
    ActorCommand, ActorRequest, BinaryPayload, ControlCommand, ControlResult, EventLoopProxy,
    GraphTransactionRequest, GraphTransactionState, GraphTransactionValue, GraphUpdate,
    LiveMixerGraph, PreparedGraphCandidate, UiEvent, Vst3ActorDeps, dispatch_build_graph, engine,
    forward_to_ui, graph_busy_error, graph_conflict_error, graph_dependency_error, graph_failure,
    graph_stale_error, graph_success, graph_timeout_error, graph_validation_error, live_graph,
    mpsc, oneshot, publish_built_graph, refresh_graph_handles, std_mpsc, validate_graph_meta,
    validate_graph_request, wait_for_graph_publication,
};

pub(in crate::runtime) async fn vst3_actor(
    mut inbox: mpsc::Receiver<ActorRequest>,
    deps: Vst3ActorDeps,
) {
    let Vst3ActorDeps {
        ui_proxy,
        ui_sender,
        processors,
        handles,
        background_sender,
        engine_sender,
        audio_engine,
        session_epoch,
    } = deps;
    let mut graph_revision = 0_u64;
    let mut graph_snapshot: Option<LiveMixerGraph> = None;
    let mut graph_transactions = GraphTransactionState::new(session_epoch);
    while let Some(message) = inbox.recv().await {
        let result = match message.command {
            ActorCommand::BuildGraph { .. }
            | ActorCommand::PublishBuiltGraph { .. }
            | ActorCommand::PreparePluginGraph { .. }
            | ActorCommand::ActivatePluginGraph { .. }
            | ActorCommand::FinishPluginGraph { .. }
            | ActorCommand::RollbackPluginGraph { .. }
            | ActorCommand::AbortPluginGraph { .. } => {
                control_error! {
                    message: "VST3 actor does not accept internal graph lifecycle commands".into(),
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
                    active_aux_inputs,
                    sample_rate,
                    component_state,
                    controller_state,
                    ara_factory_class_id,
                    ara_document_state,
                } => {
                    let component_state = resolve_deferred_binary(component_state);
                    let controller_state = resolve_deferred_binary(controller_state);
                    let ara_document_state = resolve_deferred_binary(ara_document_state);
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
                                        active_aux_inputs,
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
                        (Err(message), _, _) | (_, Err(message), _) | (_, _, Err(message)) => {
                            control_error! { message }
                        }
                    }
                }
                command @ (ControlCommand::UnloadPlugin { .. }
                | ControlCommand::PluginParameters { .. }
                | ControlCommand::SetPluginParameter { .. }
                | ControlCommand::SavePluginState { .. }
                | ControlCommand::OpenPluginEditor { .. }
                | ControlCommand::ConfigurePluginEditorAppearance { .. }
                | ControlCommand::ResolvePluginSidechainRoute { .. }
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
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_validation_error(&meta, "mutation"),
                        ));
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
                                    snapshot: graph_transactions
                                        .snapshot_with_engine(&audio_engine),
                                },
                            )
                        } else {
                            graph_failure(
                                &meta,
                                graph_busy_error(&meta, Some(candidate.operation_id.clone())),
                            )
                        };
                        let _ = message.reply.send(result);
                        continue;
                    }

                    let plugin_prepare = dispatch_ui_actor_command(
                        &ui_sender,
                        &ui_proxy,
                        ActorCommand::PreparePluginGraph {
                            operation_id: operation_id.clone(),
                            graph: request.graph.clone(),
                        },
                    )
                    .await;
                    if let ControlResult::Error { error } = plugin_prepare {
                        log_graph_transaction_failure(
                            &meta,
                            "plugin-prepare",
                            &error.correlation_id,
                        );
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_dependency_error(&meta, request.project_graph),
                        ));
                        continue;
                    }

                    let graph = request.graph;
                    let native = (|| {
                        let processors = processors
                            .lock()
                            .map_err(|_| "VST3 processor registry is poisoned".to_owned())?
                            .clone();
                        live_graph(request.graph_revision, &graph, Some(&processors))
                    })();
                    let native = match native {
                        Ok(native) => native,
                        Err(error) => {
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::AbortPluginGraph {
                                    operation_id: operation_id.clone(),
                                },
                            )
                            .await;
                            log_graph_transaction_failure(&meta, "materialize", &error);
                            let _ = message.reply.send(graph_failure(
                                &meta,
                                graph_dependency_error(&meta, request.project_graph),
                            ));
                            continue;
                        }
                    };
                    let input = match audio_engine.begin_graph_build(native) {
                        Ok(input) => input,
                        Err(error) => {
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::AbortPluginGraph {
                                    operation_id: operation_id.clone(),
                                },
                            )
                            .await;
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
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::AbortPluginGraph {
                                    operation_id: operation_id.clone(),
                                },
                            )
                            .await;
                            log_graph_transaction_failure(&meta, "compile", &error);
                            let _ = message.reply.send(graph_failure(
                                &meta,
                                graph_dependency_error(&meta, request.project_graph),
                            ));
                            continue;
                        }
                        Err(error) => {
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::AbortPluginGraph {
                                    operation_id: operation_id.clone(),
                                },
                            )
                            .await;
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
                            snapshot: graph_transactions.snapshot_with_engine(&audio_engine),
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
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_validation_error(&meta, "mutation"),
                        ));
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
                                heron_dsp_runtime::protocol::RpcStaleReason::Missing,
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

                    let plugin_activate = dispatch_ui_actor_command(
                        &ui_sender,
                        &ui_proxy,
                        ActorCommand::ActivatePluginGraph {
                            operation_id: operation_id.clone(),
                        },
                    )
                    .await;
                    if let ControlResult::Error { error } = plugin_activate {
                        log_graph_transaction_failure(
                            &meta,
                            "plugin-activate",
                            &error.correlation_id,
                        );
                        graph_transactions.restore_candidate(candidate);
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_dependency_error(&meta, request.project_graph),
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
                    if let ControlResult::Error { error } = ara_result {
                        log_graph_transaction_failure(&meta, "ara", &error.correlation_id);
                        let _ = dispatch_ui_actor_command(
                            &ui_sender,
                            &ui_proxy,
                            ActorCommand::SyncAraGraph {
                                graph: previous_graph,
                            },
                        )
                        .await;
                        let _ = dispatch_ui_actor_command(
                            &ui_sender,
                            &ui_proxy,
                            ActorCommand::RollbackPluginGraph {
                                operation_id: operation_id.clone(),
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
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::FinishPluginGraph {
                                    operation_id: operation_id.clone(),
                                },
                            )
                            .await;
                            update_graph_midi_routes(&graph);
                            refresh_graph_handles(&handles, &graph);
                            graph_revision = candidate_revision;
                            graph_snapshot = Some(graph);
                            graph_transactions.commit(
                                operation_id,
                                project_graph,
                                candidate_revision,
                            );
                            if wait_for_graph_publication(&audio_engine, candidate_revision).await {
                                graph_success(
                                    &meta,
                                    candidate_revision,
                                    GraphTransactionValue::Activated {
                                        snapshot: graph_transactions
                                            .snapshot_with_engine(&audio_engine),
                                    },
                                )
                            } else {
                                graph_failure(&meta, graph_timeout_error(&meta))
                            }
                        }
                        ControlResult::Error { error } => {
                            log_graph_transaction_failure(&meta, "publish", &error.correlation_id);
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::SyncAraGraph {
                                    graph: previous_graph,
                                },
                            )
                            .await;
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::RollbackPluginGraph {
                                    operation_id: operation_id.clone(),
                                },
                            )
                            .await;
                            graph_transactions
                                .finish_not_committed(operation_id, candidate_revision);
                            if audio_engine.published_graph_generation() >= candidate_revision {
                                graph_failure(
                                    &meta,
                                    graph_conflict_error(
                                        &meta,
                                        candidate_revision,
                                        audio_engine.published_graph_generation(),
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
                            let _ = dispatch_ui_actor_command(
                                &ui_sender,
                                &ui_proxy,
                                ActorCommand::RollbackPluginGraph {
                                    operation_id: operation_id.clone(),
                                },
                            )
                            .await;
                            graph_transactions
                                .finish_not_committed(operation_id, candidate_revision);
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
                        let _ = message.reply.send(graph_failure(
                            &meta,
                            graph_validation_error(&meta, "mutation"),
                        ));
                        continue;
                    };
                    graph_transactions.observe_engine(validated.engine);
                    let existed = graph_transactions.abort(&operation_id);
                    let _ = dispatch_ui_actor_command(
                        &ui_sender,
                        &ui_proxy,
                        ActorCommand::AbortPluginGraph {
                            operation_id: operation_id.clone(),
                        },
                    )
                    .await;
                    graph_success(
                        &meta,
                        graph_transactions.committed_revision,
                        GraphTransactionValue::Aborted {
                            operation_id,
                            existed,
                            snapshot: graph_transactions.snapshot_with_engine(&audio_engine),
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
                                    snapshot: graph_transactions
                                        .snapshot_with_engine(&audio_engine),
                                },
                            )
                        }
                        Err(error) => graph_failure(&meta, error),
                    }
                }
                ControlCommand::UpdateGraph { update } => {
                    let (revision, candidate) = match update {
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
                        let processors = processors
                            .lock()
                            .map_err(|_| "VST3 processor registry is poisoned".to_owned())?
                            .clone();
                        let graph = live_graph(revision, &candidate, Some(&processors))?;
                        Ok::<_, String>((graph, candidate))
                    })();
                    match prepared {
                        Err(message) => control_error! { message },
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
                        Err(message) => control_error! { message },
                        Ok(processors) => {
                            match tokio::task::spawn_blocking(move || {
                                engine::run_audio_benchmark(processors)
                            })
                            .await
                            {
                                Ok(Ok(report)) => ControlResult::AudioBenchmark { report },
                                Ok(Err(message)) => control_error! { message },
                                Err(error) => control_error! {
                                    message: format!(
                                        "audio benchmark worker did not complete: {error}"
                                    ),
                                },
                            }
                        }
                    }
                }
                _ => control_error! {
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
    forward_to_ui(sender, proxy, ActorRequest { command, reply }).await;
    response.await.unwrap_or_else(|_| {
        control_error! {
            message: "winit VST3 UI actor dropped its response".into(),
        }
    })
}

pub(in crate::runtime) async fn dispatch_actor(
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
        return control_error! {
            message: "audio-host actor stopped".into(),
        };
    }
    response.await.unwrap_or_else(|_| {
        control_error! {
            message: "audio-host actor dropped its response".into(),
        }
    })
}

pub(in crate::runtime) async fn dispatch_parameter(
    sender: &mpsc::Sender<ActorRequest>,
    command: heron_dsp_runtime::protocol::ParameterCommand,
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
        return control_error! {
            message: "audio-host parameter actor stopped".into(),
        };
    }
    response.await.unwrap_or_else(|_| {
        control_error! {
            message: "audio-host parameter actor dropped its response".into(),
        }
    })
}
