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
    vst3: Option<vst3::Vst3Runtime>,
    ara_graph: Option<LiveMixerGraph>,
    compositor: Option<WgpuCompositor>,
    editor_owner_window: Option<usize>,
    editors: HashMap<WindowId, EditorWindow>,
    editor_instances: HashMap<String, WindowId>,
    next_editor_tick: Option<Instant>,
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
    const RETIREMENT_TICK: Duration = Duration::from_millis(16);

    fn open_editor(
        &mut self,
        event_loop: &ActiveEventLoop,
        instance_id: String,
        preference: PluginEditorPreference,
    ) -> ControlResult {
        if !preference.is_valid() {
            return control_error! {
                message: "VST3 editor zoom is outside 50...400".into(),
            };
        }
        if let Some(window_id) = self.editor_instances.get(&instance_id).copied()
            && let Some(editor) = self.editors.get(&window_id)
        {
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
        let display_name = runtime
            .display_name(&instance_id)
            .unwrap_or("VST3 plug-in")
            .to_owned();
        let attributes = plugin_editor_window_attributes(&display_name, self.editor_owner_window);
        let window = match event_loop.create_window(attributes) {
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
            Vec::new(),
            window,
            compositor,
        );
        editor.activate_initial_mode(runtime);
        let active_mode = editor.active_mode();
        self.editor_instances.insert(instance_id, window_id);
        self.editors.insert(window_id, editor);
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
        self.compositor = None;
    }

    fn execute_vst3_request(&mut self, event_loop: &ActiveEventLoop, request: ActorRequest) {
        let ActorRequest { command, reply } = request;
        let command = match command {
            ActorCommand::Control(ControlCommand::OpenPluginEditor {
                instance_id,
                preference,
            }) => {
                let _ = reply.send(self.open_editor(event_loop, instance_id, preference));
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
                let Some(runtime) = self.vst3.as_mut() else {
                    let _ = reply.send(control_error! {
                        message: "VST3 UI runtime is shutting down".into(),
                    });
                    return;
                };
                let result = match runtime.sync_ara_graph(graph.as_ref()) {
                    Ok(()) => {
                        self.ara_graph = graph;
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
            if let Some(runtime) = self.vst3.as_mut()
                && let Err(error) = runtime.flush_output_parameters()
                && !self.output_parameter_error_reported
            {
                eprintln!("audio-host: could not apply VST3 output parameter: {error}");
                self.output_parameter_error_reported = true;
            }
            self.next_editor_tick = Some(now + Self::EDITOR_TICK);
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
            .chain(self.next_retirement_tick)
            .chain(next_plugin_timer)
            .min();
        event_loop.set_control_flow(
            deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil),
        );
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
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
            let (editors, runtime) = (&mut self.editors, &mut self.vst3);
            let (Some(editor), Some(runtime)) = (editors.get_mut(&window_id), runtime.as_mut())
            else {
                continue;
            };
            let class_id = editor.class_id.clone();
            if let Some(preference) = editor.apply_action(action, runtime) {
                let _ = self
                    .host_events
                    .try_send(HostEvent::PluginEditorPreferenceChanged {
                        class_id,
                        preference,
                    });
            }
        }
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

fn plugin_editor_window_attributes(
    display_name: &str,
    editor_owner_window: Option<usize>,
) -> WindowAttributes {
    let attributes = WindowAttributes::default()
        .with_title(format!("{display_name} — YADAW"))
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
