enum UiEvent {
    Wake,
    Exit,
}

struct WinitHost {
    generation: Arc<AtomicU64>,
    proxy: EventLoopProxy<UiEvent>,
    inbox: std_mpsc::Receiver<ActorRequest>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    audio_engine: Arc<engine::AudioEngine>,
    background_sender: mpsc::Sender<ActorRequest>,
    host_events: std_mpsc::SyncSender<HostEvent>,
    pending_ara_events: VecDeque<HostEvent>,
    vst3: Option<vst3::Vst3Runtime>,
    ara_graph: Option<LiveMixerGraph>,
    compositor: Option<WgpuCompositor>,
    editor_owner_window: Option<usize>,
    editors: HashMap<WindowId, EditorWindow>,
    editor_instances: HashMap<String, WindowId>,
    editor_menus: HashMap<WindowId, EditorMenuWindow>,
    editor_menu_for_owner: HashMap<WindowId, WindowId>,
    editor_clipboard: Option<EditorClipboard>,
    next_editor_tick: Option<Instant>,
    next_ara_tick: Option<Instant>,
    next_retirement_tick: Option<Instant>,
    output_parameter_error_reported: bool,
}

impl WinitHost {
    // VST3 controller calls must stay on this thread, but the same thread also
    // owns every native editor window. Bound each mailbox turn so plug-in code
    // cannot indefinitely delay the next platform-message dispatch.
    const UI_BATCH: usize = 4;
    const UI_BUDGET: std::time::Duration = std::time::Duration::from_millis(2);
    const EDITOR_TICK: Duration = Duration::from_millis(16);
    const ARA_CALLBACK_TICK: Duration = Duration::from_millis(33);
    const RETIREMENT_TICK: Duration = Duration::from_millis(16);

    fn poll_ara_callbacks(&mut self) {
        self.flush_pending_ara_events();
        let include_model_events = self.pending_ara_events.is_empty();
        let batches = self
            .vst3
            .as_mut()
            .map(|runtime| runtime.poll_ara_callbacks(include_model_events))
            .unwrap_or_default();
        for batch in batches {
            for (sequence, event) in batch.events {
                self.pending_ara_events.push_back(HostEvent::AraCallback {
                    instance_id: batch.instance_id.clone(),
                    sequence,
                    event,
                });
            }
            for command in batch.transport {
                let result = match command {
                    crate::ara::AraTransportCommand::Play => self.audio_engine.transport_command(
                        "play".to_owned(), None, None, None, None,
                    ),
                    crate::ara::AraTransportCommand::Pause => self.audio_engine.transport_command(
                        "pause".to_owned(), None, None, None, None,
                    ),
                    crate::ara::AraTransportCommand::SeekFrames(position) => self
                        .audio_engine
                        .transport_command("seek".to_owned(), Some(position), None, None, None),
                    crate::ara::AraTransportCommand::SetLoop {
                        enabled,
                        start_tick,
                        end_tick,
                    } => self.audio_engine.transport_command(
                        "set-loop".to_owned(),
                        None,
                        Some(enabled),
                        Some(start_tick),
                        Some(end_tick),
                    ),
                };
                if let Err(error) = result {
                    self.publish_ara_runtime_failure(&batch.instance_id, error);
                }
            }
            for failure in batch.failures {
                self.publish_ara_runtime_failure(&batch.instance_id, failure);
            }
        }
        self.flush_pending_ara_events();
    }

    fn flush_pending_ara_events(&mut self) {
        while let Some(event) = self.pending_ara_events.pop_front() {
            match self.host_events.try_send(event) {
                Ok(()) => {}
                Err(std_mpsc::TrySendError::Full(event)) => {
                    self.pending_ara_events.push_front(event);
                    break;
                }
                Err(std_mpsc::TrySendError::Disconnected(_)) => {
                    self.pending_ara_events.clear();
                    break;
                }
            }
        }
    }

    fn publish_ara_runtime_failure(&self, instance_id: &str, diagnostic: impl std::fmt::Display) {
        self.publish_plugin_runtime_failure(instance_id, "ara-playback-callback", diagnostic);
    }

    fn publish_plugin_runtime_failure(
        &self,
        instance_id: &str,
        phase: &str,
        diagnostic: impl std::fmt::Display,
    ) {
        if let ControlResult::Error { error } = crate::control_error_result(diagnostic) {
            let _ = self.host_events.try_send(HostEvent::RuntimeFailure {
                error,
                plugin_instance_id: Some(instance_id.to_owned()),
                phase: Some(phase.to_owned()),
            });
        }
    }

    fn open_editor(
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

    fn close_editor(&mut self, instance_id: &str) {
        let Some(window_id) = self.editor_instances.remove(instance_id) else {
            return;
        };
        self.close_editor_menu(window_id, false);
        if let Some(mut editor) = self.editors.remove(&window_id) {
            editor.close();
        }
        let _ = self
            .host_events
            .try_send(HostEvent::PluginEditorClosed {
                instance_id: instance_id.to_owned(),
            });
    }

    fn close_all_editors(&mut self) {
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

    fn open_editor_menu(
        &mut self,
        event_loop: &ActiveEventLoop,
        owner_id: WindowId,
        request: crate::editor_window::ToolbarMenuRequest,
    ) {
        self.close_editor_menu(owner_id, false);
        if let Some(editor) = self.editors.get_mut(&owner_id) {
            editor.popup_opened(request.menu);
        }
        let Some(parent) = self.editors.get(&owner_id).map(|editor| editor.window.clone()) else {
            return;
        };
        let result = toolbar_menu_window_attributes(&parent, &request)
            .and_then(|attributes| {
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

    fn close_editor_menu(&mut self, owner_id: WindowId, restore_focus: bool) {
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

    fn close_all_editor_menus(&mut self) {
        let owners: Vec<WindowId> = self.editor_menu_for_owner.keys().copied().collect();
        for owner_id in owners {
            self.close_editor_menu(owner_id, false);
        }
    }

    fn execute_vst3_request(&mut self, event_loop: &ActiveEventLoop, request: ActorRequest) {
        let ActorRequest { command, reply } = request;
        let command = match command {
            ActorCommand::Control(ControlCommand::OpenPluginEditor {
                instance_id,
                preference,
                context,
            }) => {
                let _ = reply.send(self.open_editor(event_loop, instance_id, preference, context));
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
            ActorCommand::Control(ControlCommand::ClosePluginEditor { instance_id }) => {
                self.close_editor(&instance_id);
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::Control(ControlCommand::UnloadPlugin { instance_id }) => {
                self.close_editor(&instance_id);
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
                    match self.audio_engine.apply_plugin_timing(&instance_id, latency, tail) {
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
        };
        let _ = reply.send(result);
    }

    fn drain_ui_mailbox(&mut self, event_loop: &ActiveEventLoop) {
        let started = std::time::Instant::now();
        let mut drained = 0;
        while should_drain_ui_request(drained, started.elapsed()) {
            match self.inbox.try_recv() {
                Ok(request) => {
                    self.execute_vst3_request(event_loop, request);
                    drained += 1;
                }
                Err(std_mpsc::TryRecvError::Empty) => return,
                Err(std_mpsc::TryRecvError::Disconnected) => return,
            }
        }
        let _ = self.proxy.send_event(UiEvent::Wake);
    }

    fn shutdown(&mut self) {
        self.close_all_editors();
        if let Ok(mut processors) = self.processors.lock() {
            processors.clear();
        }
        self.vst3.take();
        self.ara_graph = None;
        while let Ok(request) = self.inbox.try_recv() {
            let _ = request.reply.send(control_error! {
                message: "VST3 UI runtime shut down".into(),
            });
        }
    }

    fn refresh_clipboard_availability(&mut self) {
        let class_id = self
            .editor_clipboard
            .as_ref()
            .map(|clipboard| clipboard.class_id.as_str());
        for editor in self.editors.values_mut() {
            editor.set_can_paste(class_id.is_some_and(|class_id| class_id == editor.class_id));
        }
    }
}

fn replace_owned_popup<Id>(owners: &mut HashMap<Id, Id>, owner: Id, popup: Id) -> Option<Id>
where
    Id: Copy + Eq + std::hash::Hash,
{
    owners.insert(owner, popup)
}

fn remove_owned_popup<Id>(owners: &mut HashMap<Id, Id>, owner: Id) -> Option<Id>
where
    Id: Copy + Eq + std::hash::Hash,
{
    owners.remove(&owner)
}

fn milliseconds_to_samples(milliseconds: f64, sample_rate: u32) -> u32 {
    if !milliseconds.is_finite() || milliseconds <= 0.0 || sample_rate == 0 {
        return 0;
    }
    (milliseconds * f64::from(sample_rate) / 1_000.0)
        .ceil()
        .min(f64::from(u32::MAX)) as u32
}

fn vst3_host_request_payload(request: &Vst3HostRequest) -> Option<(&'static str, String)> {
    match request {
        Vst3HostRequest::DirtyChanged(dirty) => {
            Some(("dirty-changed", dirty.to_string()))
        }
        Vst3HostRequest::OpenEditor { view_name } => {
            Some(("open-editor", view_name.clone()))
        }
        Vst3HostRequest::GroupEditStarted => Some(("group-edit-started", String::new())),
        Vst3HostRequest::GroupEditFinished => Some(("group-edit-finished", String::new())),
        Vst3HostRequest::UnitSelected { unit_id } => {
            Some(("unit-selected", unit_id.to_string()))
        }
        Vst3HostRequest::ProgramListChanged {
            list_id,
            program_index,
        } => Some((
            "program-list-changed",
            format!("{list_id}:{program_index}"),
        )),
        Vst3HostRequest::UnitByBusChanged => Some(("unit-by-bus-changed", String::new())),
        Vst3HostRequest::BusActivation { .. } => None,
    }
}

fn presentation_latency_bases(
    audio_engine: &engine::AudioEngine,
    graph: Option<&LiveMixerGraph>,
) -> (u32, u32) {
    let Some(graph) = graph else {
        return (0, 0);
    };
    let Ok(snapshot) = audio_engine.audio_engine_snapshot() else {
        return (0, 0);
    };
    let output_ms = snapshot.output_latency_ms.unwrap_or(0.0)
        + snapshot.ring_buffer_latency_ms.unwrap_or(0.0)
        + snapshot.engine_latency_ms.unwrap_or(0.0);
    (
        milliseconds_to_samples(
            snapshot.input_latency_ms.unwrap_or(0.0),
            graph.sample_rate,
        ),
        milliseconds_to_samples(output_ms, graph.sample_rate),
    )
}

fn should_drain_ui_request(drained: usize, elapsed: std::time::Duration) -> bool {
    drained < WinitHost::UI_BATCH && (drained == 0 || elapsed < WinitHost::UI_BUDGET)
}

impl ApplicationHandler<UiEvent> for WinitHost {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UiEvent) {
        self.generation.fetch_add(1, Ordering::Release);
        match event {
            UiEvent::Wake => self.drain_ui_mailbox(event_loop),
            UiEvent::Exit => {
                self.shutdown();
                event_loop.exit();
            }
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        let retirement_due = self
            .next_retirement_tick
            .is_some_and(|deadline| now >= deadline);
        if retirement_due {
            if let Err(error) = self.audio_engine.reclaim_retired_graphs() {
                eprintln!("audio-host: could not reclaim retired audio graph: {error}");
            }
            if let Some(runtime) = self.vst3.as_mut() {
                runtime.reclaim_retired_instances();
                self.next_retirement_tick = runtime
                    .has_retired_instances()
                    .then_some(now + Self::RETIREMENT_TICK);
            } else {
                self.next_retirement_tick = None;
            }
        }

        if self.editors.is_empty() {
            self.next_editor_tick = None;
        } else if self.next_editor_tick.is_none_or(|deadline| now >= deadline) {
            if let Some(runtime) = self.vst3.as_mut() {
                if let Err(error) = runtime.flush_output_parameters()
                    && !self.output_parameter_error_reported
                {
                    eprintln!("audio-host: could not apply VST3 output parameter: {error}");
                    self.output_parameter_error_reported = true;
                }
                let editor_gestures = runtime.take_editor_parameter_gestures();
                for (instance_id, gestures) in editor_gestures {
                    if let Some(window_id) = self.editor_instances.get(&instance_id)
                        && let Some(editor) = self.editors.get_mut(window_id)
                    {
                        editor.apply_native_parameter_gestures(&gestures);
                    }
                }
            }
            self.next_editor_tick = Some(now + Self::EDITOR_TICK);
        }

        let has_ara_documents = self
            .vst3
            .as_ref()
            .is_some_and(vst3::Vst3Runtime::has_ara_documents);
        if !has_ara_documents {
            self.next_ara_tick = None;
        } else if self.next_ara_tick.is_none_or(|deadline| now >= deadline) {
            self.poll_ara_callbacks();
            self.next_ara_tick = Some(now + Self::ARA_CALLBACK_TICK);
        }

        let next_plugin_timer = (!self.editors.is_empty())
            .then(|| {
                self.editors
                    .values_mut()
                    .filter_map(|editor| editor.dispatch_native_run_loop(now))
                    .min()
            })
            .flatten();
        let deadline = self
            .next_editor_tick
            .into_iter()
            .chain(self.next_ara_tick)
            .chain(self.next_retirement_tick)
            .chain(next_plugin_timer)
            .min();
        event_loop.set_control_flow(
            deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil),
        );
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if self.editor_menus.contains_key(&window_id) {
            if matches!(event, WindowEvent::RedrawRequested) {
                let result = self
                    .editor_menus
                    .get_mut(&window_id)
                    .zip(self.compositor.as_mut())
                    .map(|(menu, compositor)| menu.draw(compositor));
                if let Some(Err(error)) = result {
                    let popup = self
                        .editor_menus
                        .get(&window_id)
                        .map(|menu| (menu.owner_id, menu.menu));
                    if let Some((owner_id, menu)) = popup {
                        self.close_editor_menu(owner_id, true);
                        if let Some(editor) = self.editors.get_mut(&owner_id) {
                            editor.report_popup_failure(format!("{menu:?} rendering failed: {error}"));
                        }
                    }
                }
                return;
            }
            let action = self
                .editor_menus
                .get_mut(&window_id)
                .zip(self.compositor.as_mut())
                .and_then(|(menu, compositor)| menu.handle_event(event, compositor));
            let Some(action) = action else {
                return;
            };
            let Some(owner_id) = self
                .editor_menus
                .get(&window_id)
                .map(|menu| menu.owner_id)
            else {
                return;
            };
            self.close_editor_menu(owner_id, true);
            if let EditorMenuAction::Selected(choice) = action {
                let editor_action = self
                    .editors
                    .get_mut(&owner_id)
                    .and_then(|editor| editor.apply_toolbar_choice(choice));
                if let Some(editor_action) = editor_action {
                    self.apply_editor_action(owner_id, editor_action);
                }
            }
            return;
        }

        if self.editors.contains_key(&window_id)
            && matches!(
                event,
                WindowEvent::Moved(_)
                    | WindowEvent::Resized(_)
                    | WindowEvent::ScaleFactorChanged { .. }
            )
        {
            self.close_editor_menu(window_id, false);
        }
        if matches!(event, WindowEvent::RedrawRequested) {
            let result = self
                .editors
                .get_mut(&window_id)
                .zip(self.compositor.as_mut())
                .map(|(editor, compositor)| editor.draw(compositor));
            if let Some(Err(error)) = result {
                use iced_wgpu::graphics::compositor::SurfaceError;
                match error {
                    SurfaceError::Lost | SurfaceError::Outdated => {
                        if let Some((editor, compositor)) = self
                            .editors
                            .get_mut(&window_id)
                            .zip(self.compositor.as_mut())
                        {
                            editor.reconfigure_surface(compositor);
                        }
                    }
                    SurfaceError::OutOfMemory => {
                        // Drop every editor through the normal close path so
                        // Electron observes PluginEditorClosed host events.
                        self.close_all_editors();
                    }
                    SurfaceError::Timeout | SurfaceError::Other => {}
                }
            }
            return;
        }
        let actions = match self
            .editors
            .get_mut(&window_id)
            .zip(self.compositor.as_mut())
        {
            Some((editor, compositor)) => editor.handle_event(event, compositor),
            None => return,
        };
        let mut close = false;
        for action in actions {
            if matches!(action, EditorAction::Close) {
                close = true;
                continue;
            }
            if let EditorAction::OpenToolbarMenu(request) = action {
                self.open_editor_menu(event_loop, window_id, request);
            } else {
                self.apply_editor_action(window_id, action);
            }
        }
        self.refresh_clipboard_availability();
        if close
            && let Some(instance_id) = self
                .editors
                .get(&window_id)
                .map(|editor| editor.instance_id.clone())
        {
            self.close_editor(&instance_id);
        }
    }

}

impl WinitHost {
    fn apply_editor_action(&mut self, window_id: WindowId, action: EditorAction) {
        if matches!(action, EditorAction::PreferenceChanged(_)) {
            self.close_editor_menu(window_id, false);
        }
        let (editors, runtime) = (&mut self.editors, &mut self.vst3);
        let (Some(editor), Some(runtime)) = (editors.get_mut(&window_id), runtime.as_mut()) else {
            return;
        };
        let class_id = editor.class_id.clone();
        if let Some(preference) =
            editor.apply_action(action, runtime, &mut self.editor_clipboard)
        {
            let _ = self
                .host_events
                .try_send(HostEvent::PluginEditorPreferenceChanged {
                    class_id,
                    preference,
                });
        }
    }
}

fn plugin_editor_window_attributes(
    channel_name: &str,
    plugin_name: &str,
    editor_owner_window: Option<usize>,
) -> WindowAttributes {
    let attributes = WindowAttributes::default()
        .with_title(format!("{channel_name} — {plugin_name} — YADAW"))
        .with_inner_size(LogicalSize::new(720.0, 640.0))
        // Do not expose a half-initialized surface. `present` makes the fully
        // attached editor visible and activates it in one sequence.
        .with_visible(false);
    configure_editor_window_attributes(attributes, editor_owner_window)
}

fn configure_editor_window_attributes(
    attributes: WindowAttributes,
    _editor_owner_window: Option<usize>,
) -> WindowAttributes {
    #[cfg(target_os = "windows")]
    {
        use winit::platform::windows::WindowAttributesExtWindows;

        match _editor_owner_window {
            Some(owner) => attributes
                .with_owner_window(owner as isize)
                .with_skip_taskbar(true),
            None => attributes,
        }
    }

    #[cfg(target_os = "linux")]
    {
        use winit::platform::{wayland::WindowAttributesExtWayland, x11::WindowAttributesExtX11};

        let attributes =
            WindowAttributesExtX11::with_name(attributes, editor_platform::APPLICATION_ID, "yadaw");
        WindowAttributesExtWayland::with_name(attributes, editor_platform::APPLICATION_ID, "yadaw")
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    attributes
}

fn parse_editor_owner_window(value: &str) -> Result<usize, &'static str> {
    let handle = value
        .parse::<usize>()
        .map_err(|_| "invalid --editor-owner-window value")?;
    if handle == 0 {
        Err("--editor-owner-window must not be null")
    } else {
        Ok(handle)
    }
}
