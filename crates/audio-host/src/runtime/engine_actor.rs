use super::*;

pub(super) struct ActorRequest {
    pub(super) command: ActorCommand,
    pub(super) reply: oneshot::Sender<ControlResult>,
}

pub(super) async fn forward_to_ui(
    sender: &std_mpsc::SyncSender<ActorRequest>,
    proxy: &EventLoopProxy<UiEvent>,
    mut request: ActorRequest,
) {
    loop {
        match sender.try_send(request) {
            Ok(()) => {
                let _ = proxy.send_event(UiEvent::Wake);
                return;
            }
            Err(std_mpsc::TrySendError::Full(returned)) => {
                request = returned;
                tokio::task::yield_now().await;
            }
            Err(std_mpsc::TrySendError::Disconnected(returned)) => {
                let _ = returned.reply.send(control_error! {
                    message: "winit VST3 UI mailbox stopped".into(),
                });
                return;
            }
        }
    }
}

pub(super) enum ActorCommand {
    Control(ControlCommand),
    Parameter(heron_dsp_runtime::protocol::ParameterCommand),
    /// ARA document model mutation owned by the winit/VST3 controller thread.
    SyncAraGraph {
        graph: Option<LiveMixerGraph>,
    },
    PreparePluginGraph {
        operation_id: String,
        graph: LiveMixerGraph,
    },
    ActivatePluginGraph {
        operation_id: String,
    },
    FinishPluginGraph {
        operation_id: String,
    },
    RollbackPluginGraph {
        operation_id: String,
    },
    AbortPluginGraph {
        operation_id: String,
    },
    /// Immutable mixer graph compile+publish owned by `BackgroundIoActor`.
    BuildGraph {
        graph: engine::NativeMixerGraph,
    },
    /// Generation-checked SPSC publication owned by `EngineActor`.
    PublishBuiltGraph {
        built: engine::CompiledGraphBuild,
    },
}

#[derive(Default)]
pub(super) struct GraphParameterHandles {
    pub(super) channels: HashMap<u32, String>,
    pub(super) sends: HashMap<u32, String>,
}

pub(super) fn stable_runtime_handle(namespace: u8, id: &str) -> u32 {
    let mut value = 2_166_136_261_u32 ^ u32::from(namespace);
    for byte in id.bytes() {
        value ^= u32::from(byte);
        value = value.wrapping_mul(16_777_619);
    }
    value.max(1)
}

pub(super) fn refresh_graph_handles(
    handles: &Mutex<GraphParameterHandles>,
    graph: &LiveMixerGraph,
) {
    if let Ok(mut handles) = handles.lock() {
        handles.channels = graph
            .channels
            .iter()
            .map(|channel| (stable_runtime_handle(1, &channel.id), channel.id.clone()))
            .collect();
        handles.sends = graph
            .sends
            .iter()
            .map(|send| (stable_runtime_handle(2, &send.id), send.id.clone()))
            .collect();
    }
}

pub(super) fn mixer_parameter_command(
    audio_engine: &engine::AudioEngine,
    handles: &Mutex<GraphParameterHandles>,
    command: heron_dsp_runtime::protocol::ParameterCommand,
) -> ControlResult {
    let mapping = handles.lock().ok();
    let (target, id, parameter, value) = match command.target_kind {
        heron_dsp_runtime::protocol::ParameterTargetKind::MixerChannel => {
            let Some(id) = mapping
                .as_ref()
                .and_then(|values| values.channels.get(&command.runtime_handle))
                .cloned()
            else {
                return control_error! {
                    message: "mixer channel runtime handle is stale".into(),
                };
            };
            let (parameter, value) = match command.parameter_id {
                0 => ("gainDb", -60.0 + command.normalized * 72.0),
                1 => ("pan", command.normalized * 2.0 - 1.0),
                _ => {
                    return control_error! {
                        message: "unknown mixer channel parameter".into(),
                    };
                }
            };
            ("channel", id, parameter, value)
        }
        heron_dsp_runtime::protocol::ParameterTargetKind::MixerSend => {
            let Some(id) = mapping
                .as_ref()
                .and_then(|values| values.sends.get(&command.runtime_handle))
                .cloned()
            else {
                return control_error! {
                    message: "mixer send runtime handle is stale".into(),
                };
            };
            let (parameter, value) = match command.parameter_id {
                0 => ("levelDb", -60.0 + command.normalized * 72.0),
                1 => ("pan", command.normalized * 2.0 - 1.0),
                _ => {
                    return control_error! {
                        message: "unknown mixer send parameter".into(),
                    };
                }
            };
            ("send", id, parameter, value)
        }
        heron_dsp_runtime::protocol::ParameterTargetKind::Plugin => {
            return control_error! {
                message: "plugin parameter was routed to the engine actor".into(),
            };
        }
    };
    match audio_engine.preview_mixer_parameter(engine::NativeMixerParameterPreview {
        target: target.into(),
        id,
        parameter: parameter.into(),
        value,
    }) {
        Ok(()) => ControlResult::Accepted,
        Err(error) => control_error! {
            message: error.to_string(),
        },
    }
}

pub(super) async fn engine_actor(
    mut inbox: mpsc::Receiver<ActorRequest>,
    handles: Arc<Mutex<GraphParameterHandles>>,
    audio_engine: Arc<engine::AudioEngine>,
) {
    while let Some(message) = inbox.recv().await {
        let result = match message.command {
            ActorCommand::Control(command) => engine_command(&audio_engine, command, None)
                .unwrap_or_else(|| {
                    control_error! {
                        message: "unsupported engine command".into(),
                    }
                }),
            ActorCommand::Parameter(command) => {
                mixer_parameter_command(&audio_engine, &handles, command)
            }
            ActorCommand::SyncAraGraph { .. }
            | ActorCommand::PreparePluginGraph { .. }
            | ActorCommand::ActivatePluginGraph { .. }
            | ActorCommand::FinishPluginGraph { .. }
            | ActorCommand::RollbackPluginGraph { .. }
            | ActorCommand::AbortPluginGraph { .. } => control_error! {
                message: "engine actor does not own VST3 UI state".into(),
            },
            ActorCommand::PublishBuiltGraph { built } => {
                match audio_engine.publish_mixer_runtime(built) {
                    Ok(engine::PublishOutcome::Published) => ControlResult::Accepted,
                    Ok(engine::PublishOutcome::Superseded) => control_error! {
                        message: "graph build superseded".into(),
                    },
                    Err(error) => control_error! {
                        message: error.to_string(),
                    },
                }
            }
            ActorCommand::BuildGraph { .. } => control_error! {
                message: "engine actor does not own graph construction".into(),
            },
        };
        let _ = message.reply.send(result);
    }
}

pub(super) async fn publish_built_graph(
    engine_sender: &mpsc::Sender<ActorRequest>,
    built: engine::CompiledGraphBuild,
) -> ControlResult {
    dispatch_actor_command(engine_sender, ActorCommand::PublishBuiltGraph { built }).await
}

async fn build_graph_on_worker(
    supervisor: &WorkerSupervisor,
    engine_sender: &mpsc::Sender<ActorRequest>,
    graph: engine::NativeMixerGraph,
    audio_engine: &engine::AudioEngine,
) -> ControlResult {
    let revision = graph.generation;
    let input = match audio_engine.begin_graph_build(graph) {
        Ok(input) => input,
        Err(error) => {
            return control_error! {
                message: error.to_string(),
            };
        }
    };
    let complete = match supervisor.submit_graph_build(input) {
        Ok(complete) => complete,
        Err(message) => return control_error! { message },
    };
    let built = match complete.await {
        Ok(Ok(built)) => built,
        Ok(Err(message)) => return control_error! { message },
        Err(_) => {
            return control_error! {
                message: "graph worker dropped the build result".into(),
            };
        }
    };
    match publish_built_graph(engine_sender, built).await {
        ControlResult::Accepted => ControlResult::GraphAccepted { revision },
        ControlResult::Error { .. } if audio_engine.published_graph_generation() >= revision => {
            ControlResult::GraphAccepted { revision }
        }
        other => other,
    }
}

pub(super) async fn background_io_actor(
    mut inbox: mpsc::Receiver<ActorRequest>,
    engine_sender: mpsc::Sender<ActorRequest>,
    supervisor: Arc<WorkerSupervisor>,
    audio_engine: Arc<engine::AudioEngine>,
) {
    while let Some(message) = inbox.recv().await {
        let result = match message.command {
            ActorCommand::BuildGraph { graph } => {
                build_graph_on_worker(&supervisor, &engine_sender, graph, &audio_engine).await
            }
            ActorCommand::Control(command) => engine_command(&audio_engine, command, None)
                .unwrap_or_else(|| {
                    control_error! {
                        message: "unsupported background I/O command".into(),
                    }
                }),
            ActorCommand::Parameter(_) => control_error! {
                message: "background I/O actor does not own parameters".into(),
            },
            ActorCommand::SyncAraGraph { .. }
            | ActorCommand::PreparePluginGraph { .. }
            | ActorCommand::ActivatePluginGraph { .. }
            | ActorCommand::FinishPluginGraph { .. }
            | ActorCommand::RollbackPluginGraph { .. }
            | ActorCommand::AbortPluginGraph { .. } => control_error! {
                message: "background I/O actor does not own VST3 UI state".into(),
            },
            ActorCommand::PublishBuiltGraph { .. } => control_error! {
                message: "background I/O actor does not publish graphs".into(),
            },
        };
        let _ = message.reply.send(result);
    }
    supervisor.shutdown();
}

pub(super) async fn dispatch_actor_command(
    sender: &mpsc::Sender<ActorRequest>,
    command: ActorCommand,
) -> ControlResult {
    let (reply, response) = oneshot::channel();
    if sender.send(ActorRequest { command, reply }).await.is_err() {
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

pub(super) async fn dispatch_build_graph(
    background_sender: &mpsc::Sender<ActorRequest>,
    graph: engine::NativeMixerGraph,
) -> ControlResult {
    dispatch_actor_command(background_sender, ActorCommand::BuildGraph { graph }).await
}

pub(super) fn queue_background_graph_build(
    background_sender: &mpsc::Sender<ActorRequest>,
    graph: engine::NativeMixerGraph,
) {
    let (reply, _response) = oneshot::channel();
    let _ = background_sender.try_send(ActorRequest {
        command: ActorCommand::BuildGraph { graph },
        reply,
    });
}
