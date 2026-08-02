impl EditorWindow {
    pub fn new(
        instance_id: String,
        class_id: String,
        preference: PluginEditorPreference,
        parameters: Vec<PluginParameter>,
        window: Arc<Window>,
        compositor: &mut Compositor,
    ) -> Self {
        let physical_size = window.inner_size();
        let monitor_scale = window.scale_factor();
        let user_zoom = f64::from(preference.zoom_percent) / 100.0;
        let effective_scale = effective_iced_scale(monitor_scale, user_zoom);
        let renderer = compositor.create_renderer();
        let surface = compositor.create_surface(
            window.clone(),
            physical_size.width.max(1),
            physical_size.height.max(1),
        );
        let viewport = Viewport::with_physical_size(
            Size::new(physical_size.width.max(1), physical_size.height.max(1)),
            effective_scale as f32,
        );
        Self {
            instance_id,
            class_id,
            window: window.clone(),
            preference,
            active_mode: PluginEditorMode::Parameters,
            parameters,
            warning: None,
            zoom_input: preference.zoom_percent.to_string(),
            zoom_dirty: false,
            open_menu: None,
            active_gestures: HashSet::new(),
            monitor_scale: Rc::new(Cell::new(monitor_scale)),
            user_zoom: Rc::new(Cell::new(user_zoom)),
            viewport,
            renderer,
            surface,
            cache: Cache::new(),
            clipboard: Clipboard::connect(window),
            cursor: Cursor::Unavailable,
            modifiers: ModifiersState::default(),
            platform_context: None,
            native: None,
        }
    }

    #[must_use]
    pub fn active_mode(&self) -> PluginEditorMode {
        self.active_mode
    }

    #[must_use]
    pub fn preference(&self) -> PluginEditorPreference {
        self.preference
    }

    pub fn activate_initial_mode(&mut self, runtime: &Vst3Runtime) {
        if self.preference.mode == PluginEditorMode::Native {
            if let Err(error) = self.attach_native(runtime) {
                self.warning = Some(match self.refresh_parameters(runtime) {
                    Ok(()) => error,
                    Err(parameter_error) => format!("{error} {parameter_error}"),
                });
                self.active_mode = PluginEditorMode::Parameters;
                self.request_parameter_window_size();
            }
        } else {
            if let Err(error) = self.refresh_parameters(runtime) {
                self.warning = Some(error);
            }
            self.request_parameter_window_size();
        }
        self.window.request_redraw();
    }

    pub fn focus(&self) {
        self.window.focus_window();
        if let Some(native) = &self.native {
            native.container.borrow().focus();
        }
    }

    pub fn dispatch_native_run_loop(&mut self, now: Instant) -> Option<Instant> {
        self.native
            .as_mut()
            .and_then(|native| native.frame.dispatch_run_loop(now))
    }

    pub fn close(&mut self) {
        if let Some(native) = self.native.take() {
            native.detach();
        }
        self.active_gestures.clear();
    }

    pub fn handle_event(
        &mut self,
        event: WindowEvent,
        compositor: &mut Compositor,
    ) -> Vec<EditorAction> {
        let mut actions = Vec::new();
        match &event {
            WindowEvent::CloseRequested => {
                actions.push(EditorAction::Close);
                return actions;
            }
            WindowEvent::Resized(size) => {
                self.resize_surface(*size, compositor);
                self.resize_native_to_window();
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.monitor_scale.set(*scale_factor);
                self.rebuild_viewport();
                if let Some(native) = &self.native {
                    let factor =
                        plugin_content_scale(self.monitor_scale.get(), self.user_zoom.get());
                    match native.view.set_content_scale_factor(factor) {
                        Ok(true) => {}
                        Ok(false) | Err(_) => {
                            self.warning = Some(
                                "This plug-in does not support native UI scaling; \
                                 shell scaling is still applied."
                                    .into(),
                            );
                        }
                    }
                }
                self.layout_native_preferred();
            }
            WindowEvent::CursorMoved { position, .. } => {
                let logical = position.to_logical::<f64>(self.effective_scale());
                self.cursor = Cursor::Available(Point::new(logical.x as f32, logical.y as f32));
            }
            WindowEvent::CursorLeft { .. } => self.cursor = Cursor::Unavailable,
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::Focused(false) => {
                if let Some(action) = self.commit_zoom_input() {
                    actions.push(action);
                }
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } if self.zoom_dirty => {
                if let Some(action) = self.commit_zoom_input() {
                    actions.push(action);
                }
            }
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed && !event.repeat =>
            {
                match &event.logical_key {
                    Key::Named(NamedKey::Escape) if self.zoom_dirty => {
                        self.zoom_input = self.preference.zoom_percent.to_string();
                        self.zoom_dirty = false;
                        self.window.request_redraw();
                    }
                    Key::Named(NamedKey::Enter) if self.zoom_dirty => {
                        if let Some(action) = self.commit_zoom_input() {
                            actions.push(action);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }

        let Some(event) =
            conversion::window_event(event, self.effective_scale() as f32, self.modifiers)
        else {
            return actions;
        };
        let logical_size = self.viewport.logical_size();
        let model = self.view_model();
        let view = Self::view(&model);
        let mut interface = UserInterface::build(
            view,
            logical_size,
            std::mem::take(&mut self.cache),
            &mut self.renderer,
        );
        let mut messages = Vec::new();
        interface.update(
            &[event],
            self.cursor,
            &mut self.renderer,
            &mut self.clipboard,
            &mut messages,
        );
        self.cache = interface.into_cache();
        let received_message = !messages.is_empty();
        for message in messages {
            self.update(message, &mut actions);
        }
        if received_message || !actions.is_empty() {
            self.window.request_redraw();
        }
        actions
    }

    pub fn draw(
        &mut self,
        compositor: &mut Compositor,
    ) -> Result<(), iced_wgpu::graphics::compositor::SurfaceError> {
        let logical_size = self.viewport.logical_size();
        let model = self.view_model();
        let view = Self::view(&model);
        let mut interface = UserInterface::build(
            view,
            logical_size,
            std::mem::take(&mut self.cache),
            &mut self.renderer,
        );
        // `UserInterface::build` restores widget state, but iced only computes
        // the overlay layout during `update`. Event handling and drawing use
        // separate interface instances here, so rebuild the overlay before
        // drawing open pick lists.
        let mut messages = Vec::new();
        interface.update(
            &[],
            self.cursor,
            &mut self.renderer,
            &mut self.clipboard,
            &mut messages,
        );
        interface.draw(
            &mut self.renderer,
            &Theme::TokyoNight,
            &renderer::Style {
                text_color: Color::from_rgb8(231, 235, 241),
            },
            self.cursor,
        );
        self.cache = interface.into_cache();
        let result = compositor.present(
            &mut self.renderer,
            &mut self.surface,
            &self.viewport,
            Color::from_rgb8(19, 22, 29),
            || {},
        );
        if let Err(error) = &result {
            self.warning = Some(format!("Editor shell rendering failed: {error}"));
        }
        result
    }

    pub fn reconfigure_surface(&mut self, compositor: &mut Compositor) {
        self.resize_surface(self.window.inner_size(), compositor);
    }

    pub fn apply_action(
        &mut self,
        action: EditorAction,
        runtime: &mut Vst3Runtime,
    ) -> Option<PluginEditorPreference> {
        match action {
            EditorAction::Close => None,
            EditorAction::PreferenceChanged(preference) => {
                let mode_changed = preference.mode != self.preference.mode;
                let zoom_changed = preference.zoom_percent != self.preference.zoom_percent;
                self.preference = preference;
                self.zoom_input = preference.zoom_percent.to_string();
                self.zoom_dirty = false;
                self.user_zoom
                    .set(f64::from(preference.zoom_percent) / 100.0);
                self.rebuild_viewport();

                if mode_changed {
                    self.switch_mode(preference.mode, runtime);
                } else if zoom_changed {
                    self.update_native_scale();
                }
                self.window.request_redraw();
                Some(preference)
            }
            EditorAction::Parameter {
                parameter_id,
                normalized,
                gesture,
            } => {
                if let Err(error) = runtime.set_parameter_from_editor(
                    &self.instance_id,
                    parameter_id,
                    normalized,
                    gesture,
                ) {
                    self.warning = Some(error);
                }
                if gesture != ParameterGesture::Begin
                    && let Some(parameter) = self
                        .parameters
                        .iter_mut()
                        .find(|parameter| parameter.id == parameter_id)
                {
                    parameter.normalized = normalized;
                }
                self.window.request_redraw();
                None
            }
        }
    }
}
