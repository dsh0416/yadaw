use super::window_config::presentation_latency_bases;
use super::{
    ActiveEventLoop, ActorCommand, ActorRequest, Arc, ControlCommand, ControlResult, EditorAction,
    EditorMenuWindow, EditorWindow, HostEvent, Instant, PluginEditorContext,
    PluginEditorPreference, Vst3HostRequest, WindowId, WinitHost, editor_platform,
    plugin_editor_window_attributes, queue_background_graph_build, remove_owned_popup,
    replace_owned_popup, toolbar_menu_window_attributes, vst3_host_request_payload,
};

impl WinitHost {
    pub(super) fn open_editor(
        &mut self,
        event_loop: &ActiveEventLoop,
        instance_id: String,
        preference: PluginEditorPreference,
        mut context: PluginEditorContext,
    ) -> ControlResult {
        if !preference.is_valid() {
            return control_error! {
                message: "VST3 editor zoom is outside 50...400".into(),
            };
        }
        if let Some(window_id) = self.editor_instances.get(&instance_id).copied() {
            self.close_editor_menu(window_id, false);
            let Some(editor) = self.editors.get_mut(&window_id) else {
                return control_error! {
                    message: "VST3 editor ownership is inconsistent".into(),
                };
            };
            let Some(runtime) = self.vst3.as_mut() else {
                return control_error! {
                    message: "VST3 UI runtime is shutting down".into(),
                };
            };
            editor.update_context(context);
            editor.sync_sidechain_graph(self.ara_graph.as_ref());
            if editor.preference() != preference {
                let _ = editor.apply_action(
                    EditorAction::PreferenceChanged(preference),
                    runtime,
                    &mut self.editor_clipboard,
                );
            }
            editor.present();
            return ControlResult::PluginEditor {
                active_mode: editor.active_mode(),
                open: true,
            };
        }
        let Some(runtime) = self.vst3.as_ref() else {
            return control_error! {
                message: "VST3 UI runtime is shutting down".into(),
            };
        };
        let Some(class_id) = runtime.class_id(&instance_id) else {
            return control_error! {
                message: "VST3 instance is not loaded".into(),
            };
        };
        let display_name = runtime.display_name(&instance_id).unwrap_or("VST3 plug-in");
        if context.channel_name.is_empty() {
            context.channel_name = "Untitled track".to_owned();
        }
        if context.plugin_name.is_empty() {
            context.plugin_name = display_name.to_owned();
        }
        let attributes = plugin_editor_window_attributes(
            &context.channel_name,
            &context.plugin_name,
            self.editor_owner_window,
        );
        let (window_result, platform_scale_fallback) = {
            let window_context = editor_platform::NativeEditorWindowContext::begin();
            (
                event_loop.create_window(attributes),
                window_context.supports_platform_scale_fallback(),
            )
        };
        let window = match window_result {
            Ok(window) => Arc::new(window),
            Err(error) => {
                return control_error! {
                    message: format!("could not create VST3 editor window: {error}"),
                };
            }
        };
        let window_id = window.id();
        if self.compositor.is_none() {
            match pollster::block_on(iced_wgpu::window::compositor::new(
                iced_wgpu::Settings::default(),
                window.clone(),
                iced_wgpu::graphics::Shell::headless(),
            )) {
                Ok(compositor) => self.compositor = Some(compositor),
                Err(error) => {
                    return control_error! {
                        message: format!("could not initialize the Iced WGPU renderer: {error}"),
                    };
                }
            }
        }
        let Some(compositor) = self.compositor.as_mut() else {
            return control_error! {
                message: "Iced WGPU renderer is unavailable".into(),
            };
        };
        let mut editor = EditorWindow::new(
            instance_id.clone(),
            class_id,
            preference,
            context,
            window,
            platform_scale_fallback,
            compositor,
        );
        editor.activate_initial_mode(runtime);
        editor.sync_sidechain_graph(self.ara_graph.as_ref());
        let active_mode = editor.active_mode();
        self.editor_instances.insert(instance_id, window_id);
        self.editors.insert(window_id, editor);
        self.refresh_clipboard_availability();
        if let Some(editor) = self.editors.get(&window_id) {
            editor.present();
        }
        ControlResult::PluginEditor {
            active_mode,
            open: true,
        }
    }

    pub(super) fn close_editor(&mut self, instance_id: &str) {
        let Some(window_id) = self.editor_instances.remove(instance_id) else {
            return;
        };
        self.close_editor_menu(window_id, false);
        if let Some(mut editor) = self.editors.remove(&window_id) {
            editor.close();
        }
        let _ = self.host_events.try_send(HostEvent::PluginEditorClosed {
            instance_id: instance_id.to_owned(),
        });
    }

    pub(super) fn close_all_editors(&mut self) {
        self.close_all_embedded_editors();
        let instance_ids: Vec<String> = self.editor_instances.keys().cloned().collect();
        for instance_id in instance_ids {
            self.close_editor(&instance_id);
        }
        self.editors.clear();
        self.editor_instances.clear();
        self.editor_menus.clear();
        self.editor_menu_for_owner.clear();
        self.compositor = None;
    }

    pub(super) fn open_editor_menu(
        &mut self,
        event_loop: &ActiveEventLoop,
        owner_id: WindowId,
        request: crate::editor_window::ToolbarMenuRequest,
    ) {
        self.close_editor_menu(owner_id, false);
        if let Some(editor) = self.editors.get_mut(&owner_id) {
            editor.popup_opened(request.menu);
        }
        let Some(parent) = self
            .editors
            .get(&owner_id)
            .map(|editor| editor.window.clone())
        else {
            return;
        };
        let result = toolbar_menu_window_attributes(&parent, &request).and_then(|attributes| {
            event_loop
                .create_window(attributes)
                .map(Arc::new)
                .map_err(|error| format!("could not create popup window: {error}"))
        });
        let window = match result {
            Ok(window) => window,
            Err(error) => {
                if let Some(editor) = self.editors.get_mut(&owner_id) {
                    editor.report_popup_failure(error);
                }
                return;
            }
        };
        let Some(compositor) = self.compositor.as_mut() else {
            if let Some(editor) = self.editors.get_mut(&owner_id) {
                editor.report_popup_failure("the renderer is unavailable");
            }
            return;
        };
        let popup_id = window.id();
        let menu = EditorMenuWindow::new(owner_id, request, window, compositor);
        let replaced = replace_owned_popup(&mut self.editor_menu_for_owner, owner_id, popup_id);
        debug_assert!(replaced.is_none());
        self.editor_menus.insert(popup_id, menu);
        if let Some(menu) = self.editor_menus.get(&popup_id) {
            menu.present();
        }
    }

    pub(super) fn close_editor_menu(&mut self, owner_id: WindowId, restore_focus: bool) {
        let Some(popup_id) = remove_owned_popup(&mut self.editor_menu_for_owner, owner_id) else {
            return;
        };
        self.editor_menus.remove(&popup_id);
        if let Some(editor) = self.editors.get_mut(&owner_id) {
            editor.close_popup();
            if restore_focus {
                editor.present();
            }
        }
    }

    pub(super) fn close_all_editor_menus(&mut self) {
        let owners: Vec<WindowId> = self.editor_menu_for_owner.keys().copied().collect();
        for owner_id in owners {
            self.close_editor_menu(owner_id, false);
        }
    }

    pub(super) fn execute_vst3_request(
        &mut self,
        event_loop: Option<&ActiveEventLoop>,
        request: ActorRequest,
    ) {
        let ActorRequest { command, reply } = request;
        let command = match command {
            ActorCommand::Control(ControlCommand::OpenPluginEditor {
                instance_id,
                preference,
                context,
            }) => {
                let result = match event_loop {
                    Some(event_loop) => {
                        self.open_editor(event_loop, instance_id, preference, context)
                    }
                    None => self.open_embedded_editor(instance_id, preference),
                };
                let _ = reply.send(result);
                return;
            }
            ActorCommand::Control(ControlCommand::ConfigurePluginEditorAppearance {
                appearance,
            }) => {
                self.close_all_editor_menus();
                for editor in self.editors.values_mut() {
                    editor.update_appearance(appearance);
                }
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::Control(ControlCommand::ApplyPluginEditorAction {
                instance_id,
                action,
            }) => {
                let result = if event_loop.is_none() {
                    match self.apply_embedded_editor_action(&instance_id, action) {
                        Ok(state) => ControlResult::PluginEditorToolbar { state },
                        Err(message) => control_error! { message },
                    }
                } else {
                    control_error! {
                        message: "toolbar actions require an Electron-owned plug-in editor".into(),
                    }
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
                if let Some(window_id) = self.editor_instances.get(&instance_id)
                    && let Some(editor) = self.editors.get_mut(window_id)
                {
                    editor.resolve_sidechain_request(request_id, accepted, warning);
                }
                if let Some(host) = self.embedded_editor_hosts.get_mut(&instance_id)
                    && host.pending_sidechain_request == Some(request_id)
                {
                    host.pending_sidechain_request = None;
                }
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::Control(ControlCommand::ClosePluginEditor { instance_id }) => {
                if event_loop.is_some() {
                    self.close_editor(&instance_id);
                } else {
                    self.close_embedded_editor(&instance_id, true);
                }
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::Control(ControlCommand::UnloadPlugin { instance_id }) => {
                if event_loop.is_some() {
                    self.close_editor(&instance_id);
                } else {
                    self.close_embedded_editor(&instance_id, true);
                }
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
                        for editor in self.editors.values_mut() {
                            editor.sync_sidechain_graph(graph.as_ref());
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
                            if let Some(window_id) = self.editor_instances.get(&instance_id)
                                && let Some(editor) = self.editors.get_mut(window_id)
                            {
                                editor.rebind_plugin(runtime);
                            }
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
                if let Some(runtime) = self.vst3.as_mut() {
                    let changed = runtime.rollback_graph_instances(&operation_id);
                    if let Ok(mut processors) = self.processors.lock() {
                        *processors = runtime.processor_handles();
                    }
                    for instance_id in changed {
                        if let Some(window_id) = self.editor_instances.get(&instance_id)
                            && let Some(editor) = self.editors.get_mut(window_id)
                        {
                            editor.rebind_plugin(runtime);
                        }
                    }
                    if runtime.has_retired_instances() {
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
                    match &request {
                        Vst3HostRequest::OpenEditor { .. } => {
                            if let Some(window_id) = self.editor_instances.get(&instance_id)
                                && let Some(editor) = self.editors.get(window_id)
                            {
                                editor.present();
                            }
                        }
                        Vst3HostRequest::UnitSelected { .. }
                        | Vst3HostRequest::ProgramListChanged { .. }
                        | Vst3HostRequest::UnitByBusChanged => {
                            if let Some(window_id) = self.editor_instances.get(&instance_id)
                                && let Some(editor) = self.editors.get_mut(window_id)
                            {
                                if let Err(error) = editor.refresh_parameters(runtime) {
                                    eprintln!(
                                        "audio-host: could not refresh VST3 parameter metadata: {error}"
                                    );
                                }
                                editor.window.request_redraw();
                            }
                        }
                        Vst3HostRequest::DirtyChanged(_)
                        | Vst3HostRequest::GroupEditStarted
                        | Vst3HostRequest::GroupEditFinished => {}
                        Vst3HostRequest::BusActivation { .. } => {
                            eprintln!(
                                "audio-host: an already handled VST3 bus activation reached the notification queue"
                            );
                        }
                    }
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
                    message: "winit UI thread does not own graph worker jobs".into(),
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

    pub(super) fn refresh_clipboard_availability(&mut self) {
        let class_id = self
            .editor_clipboard
            .as_ref()
            .map(|clipboard| clipboard.class_id.as_str());
        for editor in self.editors.values_mut() {
            editor.set_can_paste(class_id.is_some_and(|class_id| class_id == editor.class_id));
        }
    }

    pub(super) fn apply_editor_action(&mut self, window_id: WindowId, action: EditorAction) {
        if let EditorAction::SidechainRoute {
            input_bus_index,
            source_channel_id,
        } = action
        {
            self.next_sidechain_request_id = self.next_sidechain_request_id.wrapping_add(1).max(1);
            let request_id = self.next_sidechain_request_id;
            let Some(editor) = self.editors.get_mut(&window_id) else {
                return;
            };
            let instance_id = editor.instance_id.clone();
            if !editor.begin_sidechain_request(
                request_id,
                input_bus_index,
                source_channel_id.clone(),
            ) {
                return;
            }
            if self
                .host_events
                .try_send(HostEvent::PluginSidechainRouteRequested {
                    request_id,
                    instance_id,
                    input_bus_index,
                    source_channel_id,
                })
                .is_err()
            {
                editor.resolve_sidechain_request(
                    request_id,
                    false,
                    Some("The host event queue is busy; try again.".to_owned()),
                );
            }
            return;
        }
        if matches!(action, EditorAction::PreferenceChanged(_)) {
            self.close_editor_menu(window_id, false);
        }
        let (editors, runtime) = (&mut self.editors, &mut self.vst3);
        let (Some(editor), Some(runtime)) = (editors.get_mut(&window_id), runtime.as_mut()) else {
            return;
        };
        let class_id = editor.class_id.clone();
        if let Some(preference) = editor.apply_action(action, runtime, &mut self.editor_clipboard) {
            let _ = self
                .host_events
                .try_send(HostEvent::PluginEditorPreferenceChanged {
                    class_id,
                    preference,
                });
        }
    }
}
