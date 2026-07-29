enum UiEvent {
    Wake,
    Exit,
}

struct WinitHost {
    generation: Arc<AtomicU64>,
    proxy: EventLoopProxy<UiEvent>,
    inbox: std_mpsc::Receiver<ActorRequest>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    background_sender: mpsc::Sender<ActorRequest>,
    host_events: std_mpsc::SyncSender<HostEvent>,
    vst3: Option<vst3::Vst3Runtime>,
    ara_graph: Option<LiveMixerGraph>,
    compositor: TinySkiaCompositor,
    editor_owner_window: Option<usize>,
    editors: HashMap<WindowId, EditorWindow>,
    editor_instances: HashMap<String, WindowId>,
}

impl WinitHost {
    // VST3 controller calls must stay on this thread, but the same thread also
    // owns every native editor window. Bound each mailbox turn so plug-in code
    // cannot indefinitely delay the next platform-message dispatch.
    const UI_BATCH: usize = 4;
    const UI_BUDGET: std::time::Duration = std::time::Duration::from_millis(2);

    fn open_editor(
        &mut self,
        event_loop: &ActiveEventLoop,
        instance_id: String,
        preference: PluginEditorPreference,
    ) -> ControlResult {
        if !preference.is_valid() {
            return ControlResult::Error {
                message: "VST3 editor zoom is outside 50...400".into(),
            };
        }
        if let Some(window_id) = self.editor_instances.get(&instance_id).copied()
            && let Some(editor) = self.editors.get(&window_id)
        {
            editor.focus();
            return ControlResult::PluginEditor {
                active_mode: editor.active_mode(),
                open: true,
            };
        }
        let Some(runtime) = self.vst3.as_ref() else {
            return ControlResult::Error {
                message: "VST3 UI runtime is shutting down".into(),
            };
        };
        let Some(class_id) = runtime.class_id(&instance_id) else {
            return ControlResult::Error {
                message: "VST3 instance is not loaded".into(),
            };
        };
        let display_name = runtime
            .display_name(&instance_id)
            .unwrap_or("VST3 plug-in")
            .to_owned();
        let attributes = WindowAttributes::default()
            .with_title(format!("{display_name} — YADAW"))
            .with_inner_size(LogicalSize::new(720.0, 640.0));
        let attributes = configure_editor_window_attributes(attributes, self.editor_owner_window);
        let window = match event_loop.create_window(attributes) {
            Ok(window) => Arc::new(window),
            Err(error) => {
                return ControlResult::Error {
                    message: format!("could not create VST3 editor window: {error}"),
                };
            }
        };
        let window_id = window.id();
        let mut editor = EditorWindow::new(
            instance_id.clone(),
            class_id,
            preference,
            Vec::new(),
            window,
            &mut self.compositor,
        );
        editor.activate_initial_mode(runtime);
        let active_mode = editor.active_mode();
        self.editor_instances.insert(instance_id, window_id);
        self.editors.insert(window_id, editor);
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
                    let _ = reply.send(ControlResult::Error {
                        message: "VST3 UI runtime is shutting down".into(),
                    });
                    return;
                };
                // Benchmark (and other non-graph) instances are dropped immediately. Instances that
                // still appear in the last native mixer graph are retained until helper shutdown so
                // retiring mixer generations cannot use a freed ProcessorLease.
                let retain_for_graph = engine::native_graph_references_plugin(&instance_id);
                let _ = reply.send(runtime.unload_plugin(&instance_id, retain_for_graph));
                return;
            }
            ActorCommand::SyncAraGraph { graph } => {
                let Some(runtime) = self.vst3.as_mut() else {
                    let _ = reply.send(ControlResult::Error {
                        message: "VST3 UI runtime is shutting down".into(),
                    });
                    return;
                };
                let result = match runtime.sync_ara_graph(graph.as_ref()) {
                    Ok(()) => {
                        self.ara_graph = graph;
                        ControlResult::Accepted
                    }
                    Err(message) => ControlResult::Error { message },
                };
                let _ = reply.send(result);
                return;
            }
            command => command,
        };
        let Some(runtime) = self.vst3.as_mut() else {
            let _ = reply.send(ControlResult::Error {
                message: "VST3 UI runtime is shutting down".into(),
            });
            return;
        };
        let result = match command {
            ActorCommand::Parameter(command) => runtime.apply_parameter_command(command),
            ActorCommand::Control(ControlCommand::Ping) => {
                for (instance_id, latency, tail) in runtime.take_timing_changes() {
                    match engine::apply_plugin_timing(&instance_id, latency, tail) {
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
                let (callback_generation, transport_state) = engine::heartbeat_snapshot();
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
                    let _ = runtime.unload_plugin(instance_id, false);
                    result = ControlResult::Error { message };
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
                ControlResult::Error {
                    message: "winit UI thread does not own graph worker jobs".into(),
                }
            }
            ActorCommand::SyncAraGraph { .. } => ControlResult::Error {
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
        self.editor_instances.clear();
        for (_, mut editor) in self.editors.drain() {
            editor.close();
        }
        if let Ok(mut processors) = self.processors.lock() {
            processors.clear();
        }
        self.vst3.take();
        self.ara_graph = None;
        while let Ok(request) = self.inbox.try_recv() {
            let _ = request.reply.send(ControlResult::Error {
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

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if matches!(event, WindowEvent::RedrawRequested) {
            if let Some(editor) = self.editors.get_mut(&window_id) {
                editor.draw(&mut self.compositor);
            }
            return;
        }
        let actions = match self.editors.get_mut(&window_id) {
            Some(editor) => editor.handle_event(event, &mut self.compositor),
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
