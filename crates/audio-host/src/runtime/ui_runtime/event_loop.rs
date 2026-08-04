use super::{
    ActiveEventLoop, ApplicationHandler, ControlFlow, EditorAction, EditorMenuAction, Instant,
    Ordering, UiEvent, WindowEvent, WindowId, WinitHost, should_drain_ui_request, std_mpsc, vst3,
};

impl WinitHost {
    pub(super) fn drain_ui_mailbox(&mut self, event_loop: &ActiveEventLoop) {
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

    pub(super) fn shutdown(&mut self) {
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
        event_loop.set_control_flow(deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil));
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
                            editor.report_popup_failure(format!(
                                "{menu:?} rendering failed: {error}"
                            ));
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
            let Some(owner_id) = self.editor_menus.get(&window_id).map(|menu| menu.owner_id) else {
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
