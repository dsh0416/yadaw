impl EditorWindow {
    pub fn new(
        instance_id: String,
        class_id: String,
        preference: PluginEditorPreference,
        context: PluginEditorContext,
        window: Arc<Window>,
        platform_scale_fallback: bool,
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
            context,
            active_mode: PluginEditorMode::Parameters,
            parameters: Vec::new(),
            warning: None,
            native_scale_warning: None,
            open_menu: None,
            toolbar_anchors: HashMap::new(),
            compare_segment_focused: false,
            active_gestures: HashSet::new(),
            compare_slots: None,
            compare_slot: CompareSlot::A,
            can_paste: false,
            undo: VecDeque::new(),
            redo: VecDeque::new(),
            pending_edits: HashMap::new(),
            sidechain_buses: Vec::new(),
            sidechain_sources: Vec::new(),
            sidechain_menu: None,
            pending_sidechain: None,
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
            platform_scale_fallback,
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
        match runtime.parameters(&self.instance_id) {
            Ok(parameters) => self.parameters = parameters,
            Err(error) => self.warning = Some(error),
        }
        match runtime.editor_state(&self.instance_id) {
            Ok(state) => self.compare_slots = Some([state.clone(), state]),
            Err(error) => self.warning = Some(error),
        }
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

    pub fn present(&self) {
        // New winit windows can exist before AppKit has made them visible. On
        // macOS, focus_window intentionally does nothing for an invisible
        // window, which made the first user request look lost. Establish the
        // visibility/order first, then activate and focus the native child.
        self.window.set_minimized(false);
        self.window.set_visible(true);
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
        self.pending_edits.clear();
        self.pending_sidechain = None;
    }

    pub fn update_context(&mut self, context: PluginEditorContext) {
        merge_editor_context(&mut self.context, context);
        self.window.set_title(&format!(
            "{} — {} — Heron",
            self.context.channel_name, self.context.plugin_name
        ));
        self.window.request_redraw();
    }

    pub(crate) fn close_popup(&mut self) {
        self.close_toolbar_menu();
        self.window.request_redraw();
    }

    pub(crate) fn popup_opened(&mut self, menu: ToolbarMenu) {
        self.open_menu = Some(menu);
        self.window.request_redraw();
    }

    pub(crate) fn report_popup_failure(&mut self, error: impl fmt::Display) {
        self.close_toolbar_menu();
        self.warning = Some(popup_failure_message(error));
        self.window.request_redraw();
    }

    pub(crate) fn apply_toolbar_choice(
        &mut self,
        choice: ToolbarMenuChoice,
    ) -> Option<EditorAction> {
        self.close_toolbar_menu();
        self.window.focus_window();
        toolbar_choice_action(self.preference, choice)
    }

    pub fn update_appearance(&mut self, appearance: PluginEditorAppearance) {
        self.context.appearance = appearance;
        self.window.request_redraw();
    }

    pub fn sync_sidechain_graph(&mut self, graph: Option<&LiveMixerGraph>) {
        let Some((buses, sources)) = sidechain_view_for_graph(graph, &self.instance_id)
        else {
            self.sidechain_buses.clear();
            self.sidechain_sources.clear();
            self.close_toolbar_menu();
            self.window.request_redraw();
            return;
        };
        self.sidechain_buses = buses;
        self.sidechain_sources = sources;
        if self.sidechain_buses.is_empty() {
            self.close_toolbar_menu();
        } else if let Some(menu) = &mut self.sidechain_menu {
            menu.bus = menu.bus.min(self.sidechain_buses.len().saturating_sub(1));
        }
        self.window.request_redraw();
    }

    pub fn begin_sidechain_request(
        &mut self,
        request_id: u64,
        input_bus_index: u32,
        source_channel_id: Option<String>,
    ) -> bool {
        if !begin_sidechain_pending(
            &mut self.pending_sidechain,
            &self.sidechain_buses,
            request_id,
            input_bus_index,
            source_channel_id,
        ) {
            return false;
        }
        self.close_toolbar_menu();
        self.window.request_redraw();
        true
    }

    pub fn resolve_sidechain_request(
        &mut self,
        request_id: u64,
        accepted: bool,
        warning: Option<String>,
    ) {
        if !resolve_sidechain_pending(
            &mut self.pending_sidechain,
            &mut self.warning,
            request_id,
            accepted,
            warning,
        ) {
            return;
        }
        self.window.request_redraw();
    }

    pub fn set_can_paste(&mut self, can_paste: bool) {
        if self.can_paste != can_paste {
            self.can_paste = can_paste;
            self.window.request_redraw();
        }
    }

    pub fn apply_native_parameter_gestures(
        &mut self,
        gestures: &[heron_vst3_host::EditorParameterGesture],
    ) {
        for gesture in gestures {
            match *gesture {
                heron_vst3_host::EditorParameterGesture::Begin { parameter_id } => {
                    if let Some(parameter) = self
                        .parameters
                        .iter()
                        .find(|parameter| parameter.id == parameter_id)
                    {
                        self.pending_edits
                            .entry(parameter_id)
                            .or_insert(parameter.normalized);
                    }
                }
                heron_vst3_host::EditorParameterGesture::Perform {
                    parameter_id,
                    normalized,
                } => {
                    if let Some(parameter) = self
                        .parameters
                        .iter_mut()
                        .find(|parameter| parameter.id == parameter_id)
                    {
                        parameter.normalized = normalized;
                    }
                }
                heron_vst3_host::EditorParameterGesture::End { parameter_id } => {
                    let after = self
                        .parameters
                        .iter()
                        .find(|parameter| parameter.id == parameter_id)
                        .map(|parameter| parameter.normalized);
                    if let (Some(before), Some(after)) =
                        (self.pending_edits.remove(&parameter_id), after)
                        && (before - after).abs() > f64::EPSILON
                    {
                        push_parameter_edit(
                            &mut self.undo,
                            ParameterEdit {
                                parameter_id,
                                before,
                                after,
                            },
                        );
                        self.redo.clear();
                    }
                }
            }
        }
        if !gestures.is_empty() {
            self.window.request_redraw();
        }
    }

    pub(crate) fn handle_event(
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
                self.update_native_scale();
            }
            WindowEvent::CursorMoved { position, .. } => {
                let logical = position.to_logical::<f64>(self.effective_scale());
                self.cursor = Cursor::Available(Point::new(logical.x as f32, logical.y as f32));
            }
            WindowEvent::CursorLeft { .. } => self.cursor = Cursor::Unavailable,
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed && !event.repeat =>
            {
                let (consumed, action) = self.handle_sidechain_key(&event.logical_key);
                if consumed {
                    if let Some(action) = action
                        && self.pending_sidechain.is_none()
                    {
                        actions.push(action);
                    }
                    self.window.request_redraw();
                    return actions;
                }
                match &event.logical_key {
                    Key::Named(NamedKey::ArrowLeft) if self.compare_segment_focused => {
                        actions.push(EditorAction::UseCompareSlot(CompareSlot::A));
                    }
                    Key::Named(NamedKey::ArrowRight) if self.compare_segment_focused => {
                        actions.push(EditorAction::UseCompareSlot(CompareSlot::B));
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
        // Parameters mode still uses iced's in-surface pick lists. Native mode
        // has no parent-surface overlay to rebuild because its menus are owned
        // windows managed by the runtime.
        if model.active_mode == PluginEditorMode::Parameters {
            let mut messages = Vec::new();
            interface.update(
                &[],
                self.cursor,
                &mut self.renderer,
                &mut self.clipboard,
                &mut messages,
            );
        }
        let appearance = editor_appearance(model.context.appearance.theme);
        let theme = appearance.theme();
        let colors = appearance.palette();
        interface.draw(
            &mut self.renderer,
            &theme,
            &renderer::Style {
                text_color: colors.text,
            },
            self.cursor,
        );
        self.cache = interface.into_cache();
        let result = compositor.present(
            &mut self.renderer,
            &mut self.surface,
            &self.viewport,
            colors.canvas,
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

    pub(crate) fn apply_action(
        &mut self,
        action: EditorAction,
        runtime: &mut Vst3Runtime,
        clipboard: &mut Option<EditorClipboard>,
    ) -> Option<PluginEditorPreference> {
        match action {
            EditorAction::Close => None,
            EditorAction::OpenToolbarMenu(_) => None,
            EditorAction::PreferenceChanged(preference) => {
                let mode_changed = preference.mode != self.preference.mode;
                let zoom_changed = preference.zoom_percent != self.preference.zoom_percent;
                self.preference = preference;
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
            EditorAction::UseCompareSlot(slot) => {
                if slot != self.compare_slot {
                    let result = runtime.editor_state(&self.instance_id).and_then(|current| {
                        let Some(slots) = self.compare_slots.as_mut() else {
                            return Err("A/B comparison is unavailable".to_owned());
                        };
                        restore_compare_slot(slots, self.compare_slot, slot, current, |target| {
                            runtime.restore_editor_state(&self.instance_id, target)
                        })
                    });
                    match result {
                        Ok(()) => {
                            self.compare_slot = slot;
                            self.clear_parameter_history();
                            self.refresh_after_state_restore(runtime);
                        }
                        Err(error) => self.warning = Some(error),
                    }
                }
                self.window.request_redraw();
                None
            }
            EditorAction::CopyState => {
                match runtime.editor_state(&self.instance_id) {
                    Ok(state) => {
                        *clipboard = Some(EditorClipboard {
                            class_id: self.class_id.clone(),
                            state,
                        });
                    }
                    Err(error) => self.warning = Some(error),
                }
                self.window.request_redraw();
                None
            }
            EditorAction::PasteState => {
                let result = clipboard
                    .as_ref()
                    .filter(|contents| contents.supports(&self.class_id))
                    .ok_or_else(|| "Copied settings belong to a different plug-in".to_owned())
                    .and_then(|contents| {
                        runtime.restore_editor_state(&self.instance_id, &contents.state)?;
                        Ok(contents.state.clone())
                    });
                match result {
                    Ok(state) => {
                        update_active_compare_slot(
                            &mut self.compare_slots,
                            self.compare_slot,
                            state,
                        );
                        self.clear_parameter_history();
                        self.refresh_after_state_restore(runtime);
                    }
                    Err(error) => self.warning = Some(error),
                }
                self.window.request_redraw();
                None
            }
            EditorAction::Undo => {
                if let Some(edit) = self.undo.pop_back() {
                    match self.apply_parameter_value(runtime, edit.parameter_id, edit.before) {
                        Ok(()) => push_parameter_edit(&mut self.redo, edit),
                        Err(error) => {
                            self.undo.push_back(edit);
                            self.warning = Some(error);
                        }
                    }
                }
                self.window.request_redraw();
                None
            }
            EditorAction::Redo => {
                if let Some(edit) = self.redo.pop_back() {
                    match self.apply_parameter_value(runtime, edit.parameter_id, edit.after) {
                        Ok(()) => push_parameter_edit(&mut self.undo, edit),
                        Err(error) => {
                            self.redo.push_back(edit);
                            self.warning = Some(error);
                        }
                    }
                }
                self.window.request_redraw();
                None
            }
            EditorAction::Parameter {
                parameter_id,
                normalized,
                gesture,
            } => {
                if gesture == ParameterGesture::Begin
                    && !self.pending_edits.contains_key(&parameter_id)
                    && let Ok(parameters) = runtime.parameters(&self.instance_id)
                    && let Some(parameter) = parameters
                        .iter()
                        .find(|parameter| parameter.id == parameter_id)
                {
                    self.pending_edits
                        .insert(parameter_id, parameter.normalized);
                }
                let result = runtime.set_parameter_from_editor(
                    &self.instance_id,
                    parameter_id,
                    normalized,
                    gesture,
                );
                if let Err(error) = result {
                    self.warning = Some(error);
                    if gesture == ParameterGesture::End {
                        self.pending_edits.remove(&parameter_id);
                    }
                    self.window.request_redraw();
                    return None;
                }
                if gesture != ParameterGesture::Begin
                    && let Some(parameter) = self
                        .parameters
                        .iter_mut()
                        .find(|parameter| parameter.id == parameter_id)
                {
                    parameter.normalized = normalized;
                }
                if gesture == ParameterGesture::End
                    && let Some(before) = self.pending_edits.remove(&parameter_id)
                    && (before - normalized).abs() > f64::EPSILON
                {
                    push_parameter_edit(
                        &mut self.undo,
                        ParameterEdit {
                            parameter_id,
                            before,
                            after: normalized,
                        },
                    );
                    self.redo.clear();
                }
                self.window.request_redraw();
                None
            }
            EditorAction::SidechainRoute { .. } => None,
        }
    }

    fn apply_parameter_value(
        &mut self,
        runtime: &mut Vst3Runtime,
        parameter_id: u32,
        normalized: f64,
    ) -> Result<(), String> {
        for gesture in [
            ParameterGesture::Begin,
            ParameterGesture::Perform,
            ParameterGesture::End,
        ] {
            runtime.set_parameter_from_editor(
                &self.instance_id,
                parameter_id,
                normalized,
                gesture,
            )?;
        }
        if let Some(parameter) = self
            .parameters
            .iter_mut()
            .find(|parameter| parameter.id == parameter_id)
        {
            parameter.normalized = normalized;
        }
        Ok(())
    }

    fn clear_parameter_history(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.pending_edits.clear();
    }

    fn refresh_after_state_restore(&mut self, runtime: &Vst3Runtime) {
        match runtime.parameters(&self.instance_id) {
            Ok(parameters) => {
                self.parameters = parameters;
                self.warning = None;
            }
            Err(error) => self.warning = Some(error),
        }
    }
}

fn merge_editor_context(current: &mut PluginEditorContext, update: PluginEditorContext) {
    if !update.channel_name.is_empty() {
        current.channel_name = update.channel_name;
    }
    if !update.channel_color.is_empty() {
        current.channel_color = update.channel_color;
    }
    if !update.plugin_name.is_empty() {
        current.plugin_name = update.plugin_name;
    }
    current.appearance = update.appearance;
}

fn popup_failure_message(error: impl fmt::Display) -> String {
    format!("Could not open the toolbar menu: {error}. Try again.")
}

fn toolbar_choice_action(
    preference: PluginEditorPreference,
    choice: ToolbarMenuChoice,
) -> Option<EditorAction> {
    match choice {
        ToolbarMenuChoice::Mode(mode) if mode != preference.mode => {
            Some(EditorAction::PreferenceChanged(PluginEditorPreference {
                mode,
                zoom_percent: preference.zoom_percent,
            }))
        }
        ToolbarMenuChoice::Zoom(zoom_percent) if zoom_percent != preference.zoom_percent => {
            Some(EditorAction::PreferenceChanged(PluginEditorPreference {
                mode: preference.mode,
                zoom_percent,
            }))
        }
        ToolbarMenuChoice::SidechainRoute {
            input_bus_index,
            source_channel_id,
        } => Some(EditorAction::SidechainRoute {
            input_bus_index,
            source_channel_id,
        }),
        ToolbarMenuChoice::Mode(_) | ToolbarMenuChoice::Zoom(_) => None,
    }
}

fn push_parameter_edit(history: &mut VecDeque<ParameterEdit>, edit: ParameterEdit) {
    if history.len() == PARAMETER_HISTORY_LIMIT {
        history.pop_front();
    }
    history.push_back(edit);
}
