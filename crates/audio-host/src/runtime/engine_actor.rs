use super::{
    Arc, ControlCommand, ControlResult, HashMap, LiveMixerGraph, Mutex, UiEvent, UiMailboxWaker,
    WorkerSupervisor, engine, engine_command, mpsc, oneshot, std_mpsc,
};

pub(super) struct ActorRequest {
    pub(super) command: ActorCommand,
    pub(super) reply: oneshot::Sender<ControlResult>,
}

pub(super) async fn forward_to_ui(
    sender: &std_mpsc::SyncSender<ActorRequest>,
    proxy: &UiMailboxWaker,
    mut request: ActorRequest,
) {
    loop {
        match sender.try_send(request) {
            Ok(()) => {
                proxy.send_event(UiEvent::Wake);
                return;
            }
            Err(std_mpsc::TrySendError::Full(returned)) => {
                request = returned;
                tokio::task::yield_now().await;
            }
            Err(std_mpsc::TrySendError::Disconnected(returned)) => {
                let _ = returned.reply.send(control_error! {
                    message: "VST3 main-thread mailbox stopped".into(),
                });
                return;
            }
        }
    }
}

pub(super) enum ActorCommand {
    Control(ControlCommand),
    Parameter(heron_dsp_runtime::protocol::ParameterCommand),
    /// ARA document model mutation owned by the embedded UI/VST3 controller thread.
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
            let (parameter, value) = match command.parameter_token {
                0 => ("gainDb", -60.0 + command.value * 72.0),
                1 => ("pan", command.value * 2.0 - 1.0),
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
            let (parameter, value) = match command.parameter_token {
                0 => ("levelDb", -60.0 + command.value * 72.0),
                1 => ("pan", command.value * 2.0 - 1.0),
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
        let engine = Arc::clone(&audio_engine);
        let parameter_handles = Arc::clone(&handles);
        let result = tokio::task::spawn_blocking(move || match message.command {
            ActorCommand::Control(command) => engine_command(&engine, command, None)
                .unwrap_or_else(|| {
                    control_error! {
                        message: "unsupported engine command".into(),
                    }
                }),
            ActorCommand::Parameter(command) => {
                mixer_parameter_command(&engine, &parameter_handles, command)
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
                match engine.publish_mixer_runtime(built) {
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
        })
        .await
        .unwrap_or_else(|error| {
            control_error! {
                message: format!("engine blocking task failed: {error}"),
            }
        });
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
            ActorCommand::Control(command) => {
                let engine = Arc::clone(&audio_engine);
                tokio::task::spawn_blocking(move || engine_command(&engine, command, None))
                    .await
                    .unwrap_or_else(|error| {
                        Some(control_error! {
                            message: format!("background blocking task failed: {error}"),
                        })
                    })
                    .unwrap_or_else(|| {
                        control_error! {
                            message: "unsupported background I/O command".into(),
                        }
                    })
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use heron_dsp_runtime::protocol::{
        LiveLatencyPolicy, ParameterCommand, ParameterGesture, ParameterTargetKind,
    };

    fn parameter(
        target_kind: ParameterTargetKind,
        runtime_handle: u32,
        parameter_token: u32,
        value: f64,
    ) -> ParameterCommand {
        ParameterCommand {
            session_epoch: 1,
            sequence: 1,
            target_kind,
            runtime_handle,
            parameter_token,
            target_generation: 1,
            value,
            gesture: ParameterGesture::Perform,
        }
    }

    fn empty_graph() -> LiveMixerGraph {
        LiveMixerGraph {
            sample_rate: 48_000,
            project_end_tick: 0,
            latency_policy: LiveLatencyPolicy::Normal,
            channels: Vec::new(),
            sends: Vec::new(),
            clips: Vec::new(),
            plugins: Vec::new(),
            midi_clips: Vec::new(),
            tempo_events: Vec::new(),
            time_signature_events: Vec::new(),
        }
    }

    #[test]
    fn stable_handles_are_deterministic_nonzero_and_namespaced() {
        assert_eq!(
            stable_runtime_handle(1, "channel"),
            stable_runtime_handle(1, "channel")
        );
        assert_ne!(
            stable_runtime_handle(1, "channel"),
            stable_runtime_handle(2, "channel")
        );
        assert_ne!(
            stable_runtime_handle(1, "channel"),
            stable_runtime_handle(1, "send")
        );
        assert_ne!(stable_runtime_handle(1, ""), 0);

        let handles = Mutex::new(GraphParameterHandles::default());
        refresh_graph_handles(&handles, &empty_graph());
        let handles = handles.lock().unwrap();
        assert!(handles.channels.is_empty());
        assert!(handles.sends.is_empty());
    }

    #[test]
    fn mixer_parameters_reject_stale_unknown_and_misdirected_tokens() {
        let engine = engine::AudioEngine::new();
        let handles = Mutex::new(GraphParameterHandles::default());
        let channel = stable_runtime_handle(1, "channel");
        let send = stable_runtime_handle(2, "send");
        {
            let mut values = handles.lock().unwrap();
            values.channels.insert(channel, "channel".to_owned());
            values.sends.insert(send, "send".to_owned());
        }

        for command in [
            parameter(ParameterTargetKind::MixerChannel, 99, 0, 0.5),
            parameter(ParameterTargetKind::MixerChannel, channel, 99, 0.5),
            parameter(ParameterTargetKind::MixerSend, 99, 0, 0.5),
            parameter(ParameterTargetKind::MixerSend, send, 99, 0.5),
            parameter(ParameterTargetKind::Plugin, 1, 0, 0.5),
        ] {
            assert!(matches!(
                mixer_parameter_command(&engine, &handles, command),
                ControlResult::Error { .. }
            ));
        }
        for command in [
            parameter(ParameterTargetKind::MixerChannel, channel, 0, 0.5),
            parameter(ParameterTargetKind::MixerChannel, channel, 1, 0.5),
            parameter(ParameterTargetKind::MixerSend, send, 0, 0.5),
            parameter(ParameterTargetKind::MixerSend, send, 1, 0.5),
        ] {
            assert!(matches!(
                mixer_parameter_command(&engine, &handles, command),
                ControlResult::Accepted | ControlResult::Error { .. }
            ));
        }
    }

    #[tokio::test]
    async fn engine_actor_replies_to_control_parameter_and_wrong_owner_commands() {
        let (sender, inbox) = mpsc::channel(8);
        let task = tokio::spawn(engine_actor(
            inbox,
            Arc::new(Mutex::new(GraphParameterHandles::default())),
            Arc::new(engine::AudioEngine::new()),
        ));

        assert!(matches!(
            dispatch_actor_command(&sender, ActorCommand::Control(ControlCommand::Ping)).await,
            ControlResult::Error { .. }
        ));
        assert!(matches!(
            dispatch_actor_command(
                &sender,
                ActorCommand::Parameter(parameter(ParameterTargetKind::Plugin, 1, 0, 0.5)),
            )
            .await,
            ControlResult::Error { .. }
        ));
        assert!(matches!(
            dispatch_actor_command(&sender, ActorCommand::SyncAraGraph { graph: None }).await,
            ControlResult::Error { .. }
        ));

        drop(sender);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn dispatch_reports_closed_sender_and_dropped_response() {
        let (sender, inbox) = mpsc::channel(1);
        drop(inbox);
        assert!(matches!(
            dispatch_actor_command(&sender, ActorCommand::Control(ControlCommand::Ping)).await,
            ControlResult::Error { .. }
        ));

        let (sender, mut inbox) = mpsc::channel::<ActorRequest>(1);
        let response = tokio::spawn(async move {
            let request = inbox.recv().await.unwrap();
            drop(request.reply);
        });
        assert!(matches!(
            dispatch_actor_command(&sender, ActorCommand::Control(ControlCommand::Ping)).await,
            ControlResult::Error { .. }
        ));
        response.await.unwrap();
    }
}
