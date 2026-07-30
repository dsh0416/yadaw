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

async fn vst3_actor(
    mut inbox: mpsc::Receiver<ActorRequest>,
    ui_proxy: EventLoopProxy<UiEvent>,
    ui_sender: std_mpsc::SyncSender<ActorRequest>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    handles: Arc<Mutex<GraphParameterHandles>>,
    request_arena: Arc<Mutex<ArenaReceiver>>,
    background_sender: mpsc::Sender<ActorRequest>,
) {
    let mut graph_revision = 0_u64;
    let mut graph_snapshot: Option<LiveMixerGraph> = None;
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
                        let graph = live_graph(revision, &candidate, Some(&processors), &arena)?;
                        materialize_mixer_graph(&mut candidate, &arena)
                            .map_err(|error| error.to_string())?;
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
                                    refresh_graph_handles(&handles, &candidate);
                                    graph_revision = accepted_revision;
                                    graph_snapshot = Some(candidate);
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
