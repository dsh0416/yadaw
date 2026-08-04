use super::window_config::presentation_latency_bases;
use super::{
    ActorCommand, ActorRequest, ControlCommand, ControlResult, EmbeddedUiHost, HostEvent, Instant,
    queue_background_graph_build, vst3_host_request_payload,
};

impl EmbeddedUiHost {
    pub(super) fn execute_vst3_request(&mut self, request: ActorRequest) {
        let ActorRequest { command, reply } = request;
        let command = match command {
            ActorCommand::Control(ControlCommand::OpenPluginEditor {
                instance_id,
                preference,
                context,
            }) => {
                let _ = context;
                let result = self.open_embedded_editor(instance_id, preference);
                let _ = reply.send(result);
                return;
            }
            ActorCommand::Control(ControlCommand::ConfigurePluginEditorAppearance {
                appearance,
            }) => {
                let _ = appearance;
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::Control(ControlCommand::ApplyPluginEditorAction {
                instance_id,
                action,
            }) => {
                let result = match self.apply_embedded_editor_action(&instance_id, action) {
                    Ok(state) => ControlResult::PluginEditorToolbar { state },
                    Err(message) => control_error! { message },
                };
                let _ = reply.send(result);
                return;
            }
            ActorCommand::Control(ControlCommand::ResolvePluginSidechainRoute {
                request_id,
                instance_id,
                accepted,
                warning,
            }) => {
                if let Some(host) = self.embedded_editor_hosts.get_mut(&instance_id)
                    && host.pending_sidechain_request == Some(request_id)
                {
                    host.pending_sidechain_request = None;
                }
                let _ = (accepted, warning);
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::Control(ControlCommand::ClosePluginEditor { instance_id }) => {
                self.close_embedded_editor(&instance_id, true);
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::Control(ControlCommand::UnloadPlugin { instance_id }) => {
                self.close_embedded_editor(&instance_id, true);
                if let Ok(mut processors) = self.processors.lock() {
                    processors.remove(&instance_id);
                }
                let Some(runtime) = self.vst3.as_mut() else {
                    let _ = reply.send(control_error! {
                        message: "VST3 UI runtime is shutting down".into(),
                    });
                    return;
                };
                let result = runtime.unload_plugin(&instance_id);
                if runtime.has_retired_instances() {
                    self.next_retirement_tick = Some(Instant::now());
                }
                let _ = reply.send(result);
                return;
            }
            ActorCommand::SyncAraGraph { graph } => {
                let (input_device_samples, output_pipeline_samples) =
                    presentation_latency_bases(&self.audio_engine, graph.as_ref());
                let Some(runtime) = self.vst3.as_mut() else {
                    let _ = reply.send(control_error! {
                        message: "VST3 UI runtime is shutting down".into(),
                    });
                    return;
                };
                let presentation_error = runtime
                    .sync_presentation_latencies(
                        graph.as_ref(),
                        input_device_samples,
                        output_pipeline_samples,
                    )
                    .err();
                let result = match runtime.sync_ara_graph(graph.as_ref()) {
                    Ok(()) => {
                        if let Some(error) = presentation_error {
                            eprintln!(
                                "audio-host: could not update VST3 presentation latency: {error}"
                            );
                        }
                        self.ara_graph = graph;
                        self.next_ara_tick = Some(Instant::now());
                        ControlResult::Accepted
                    }
                    Err(message) => control_error! { message },
                };
                let _ = reply.send(result);
                return;
            }
            ActorCommand::PreparePluginGraph {
                operation_id,
                graph,
            } => {
                let Some(runtime) = self.vst3.as_mut() else {
                    let _ = reply.send(control_error! {
                        message: "VST3 UI runtime is shutting down".into(),
                    });
                    return;
                };
                let result = match runtime.prepare_graph_instances(&operation_id, &graph) {
                    Ok(()) => {
                        if let Ok(mut processors) = self.processors.lock() {
                            *processors = runtime.graph_processor_handles(&operation_id);
                        }
                        ControlResult::Accepted
                    }
                    Err(message) => control_error! { message },
                };
                let _ = reply.send(result);
                return;
            }
            ActorCommand::ActivatePluginGraph { operation_id } => {
                let Some(runtime) = self.vst3.as_mut() else {
                    let _ = reply.send(control_error! {
                        message: "VST3 UI runtime is shutting down".into(),
                    });
                    return;
                };
                let result = match runtime.activate_graph_instances(&operation_id) {
                    Ok(changed) => {
                        if let Ok(mut processors) = self.processors.lock() {
                            *processors = runtime.processor_handles();
                        }
                        for instance_id in changed {
                            self.rebind_embedded_editor(&instance_id);
                        }
                        ControlResult::Accepted
                    }
                    Err(message) => control_error! { message },
                };
                let _ = reply.send(result);
                return;
            }
            ActorCommand::FinishPluginGraph { operation_id } => {
                if let Some(runtime) = self.vst3.as_mut() {
                    runtime.finish_graph_instances(&operation_id);
                    if runtime.has_retired_instances() {
                        self.next_retirement_tick = Some(Instant::now());
                    }
                }
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::RollbackPluginGraph { operation_id } => {
                let rollback = if let Some(runtime) = self.vst3.as_mut() {
                    let changed = runtime.rollback_graph_instances(&operation_id);
                    if let Ok(mut processors) = self.processors.lock() {
                        *processors = runtime.processor_handles();
                    }
                    Some((changed, runtime.has_retired_instances()))
                } else {
                    None
                };
                if let Some((changed, has_retired_instances)) = rollback {
                    for instance_id in changed {
                        self.rebind_embedded_editor(&instance_id);
                    }
                    if has_retired_instances {
                        self.next_retirement_tick = Some(Instant::now());
                    }
                }
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::AbortPluginGraph { operation_id } => {
                if let Some(runtime) = self.vst3.as_mut() {
                    runtime.abort_graph_instances(&operation_id);
                    if let Ok(mut processors) = self.processors.lock() {
                        *processors = runtime.processor_handles();
                    }
                }
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            command => command,
        };
        let Some(runtime) = self.vst3.as_mut() else {
            let _ = reply.send(control_error! {
                message: "VST3 UI runtime is shutting down".into(),
            });
            return;
        };
        let result = match command {
            ActorCommand::Parameter(command) => runtime.apply_parameter_command(command),
            ActorCommand::Control(ControlCommand::Ping) => {
                for (instance_id, latency, tail) in runtime.take_timing_changes() {
                    if let Some(plugin) = self.ara_graph.as_mut().and_then(|graph| {
                        graph
                            .plugins
                            .iter_mut()
                            .find(|plugin| plugin.instance_id == instance_id)
                    }) {
                        plugin.latency_samples = latency;
                        plugin.tail_samples = tail;
                    }
                    match self
                        .audio_engine
                        .apply_plugin_timing(&instance_id, latency, tail)
                    {
                        Ok(Some(graph)) => {
                            queue_background_graph_build(&self.background_sender, graph);
                        }
                        Ok(None) => {}
                        Err(error) => {
                            eprintln!(
                                "audio-host: could not apply dynamic plugin latency: {error}"
                            );
                        }
                    }
                }
                let (input_device_samples, output_pipeline_samples) =
                    presentation_latency_bases(&self.audio_engine, self.ara_graph.as_ref());
                if let Err(error) = runtime.sync_presentation_latencies(
                    self.ara_graph.as_ref(),
                    input_device_samples,
                    output_pipeline_samples,
                ) {
                    eprintln!("audio-host: could not update VST3 presentation latency: {error}");
                }
                let restart_failures = runtime.take_restart_failures();
                for (instance_id, request) in runtime.take_host_requests() {
                    if let Some((kind, value)) = vst3_host_request_payload(&request)
                        && self
                            .host_events
                            .try_send(HostEvent::PluginRuntime {
                                instance_id,
                                kind: kind.to_owned(),
                                value,
                            })
                            .is_err()
                    {
                        eprintln!("audio-host: VST3 host request notification queue is full");
                    }
                }
                for (instance_id, failure) in restart_failures {
                    self.publish_plugin_runtime_failure(&instance_id, "vst3-restart", failure);
                }
                let (callback_generation, transport_state) = self.audio_engine.heartbeat_snapshot();
                ControlResult::Heartbeat {
                    ipc_generation: 0,
                    tokio_generation: 0,
                    winit_generation: 0,
                    callback_generation,
                    transport_state,
                }
            }
            ActorCommand::Control(command) => {
                let loaded_id = match &command {
                    ControlCommand::LoadPlugin { instance_id, .. } => Some(instance_id.clone()),
                    _ => None,
                };
                let mut result = runtime.execute(command);
                if matches!(result, ControlResult::PluginLoaded { .. })
                    && let Some(instance_id) = loaded_id.as_ref()
                    && let Err(message) = runtime.sync_ara_graph(self.ara_graph.as_ref())
                {
                    let _ = runtime.unload_plugin(instance_id);
                    result = control_error! { message };
                }
                if matches!(result, ControlResult::PluginLoaded { .. })
                    && let Some(instance_id) = loaded_id
                    && let Some(processor) = runtime.processor_handle(&instance_id)
                    && let Ok(mut processors) = self.processors.lock()
                {
                    processors.insert(instance_id, processor);
                }
                result
            }
            ActorCommand::BuildGraph { .. } | ActorCommand::PublishBuiltGraph { .. } => {
                control_error! {
                    message: "VST3 UI owner does not own graph worker jobs".into(),
                }
            }
            ActorCommand::SyncAraGraph { .. } => control_error! {
                message: "ARA graph synchronization was not handled".into(),
            },
            ActorCommand::PreparePluginGraph { .. }
            | ActorCommand::ActivatePluginGraph { .. }
            | ActorCommand::FinishPluginGraph { .. }
            | ActorCommand::RollbackPluginGraph { .. }
            | ActorCommand::AbortPluginGraph { .. } => control_error! {
                message: "plug-in graph lifecycle was not handled".into(),
            },
        };
        let _ = reply.send(result);
    }
}
