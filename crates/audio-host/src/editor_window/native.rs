impl EditorWindow {
    pub(crate) fn rebind_plugin(&mut self, runtime: &Vst3Runtime) {
        if self.active_mode == PluginEditorMode::Native {
            if let Some(native) = self.native.take() {
                native.detach();
            }
            if let Err(error) = self.attach_native(runtime) {
                self.warning = Some(error);
                self.active_mode = PluginEditorMode::Parameters;
                let _ = self.refresh_parameters(runtime);
                self.request_parameter_window_size();
            }
        } else if let Err(error) = self.refresh_parameters(runtime) {
            self.warning = Some(error);
        }
        self.window.request_redraw();
    }

    fn switch_mode(&mut self, mode: PluginEditorMode, runtime: &Vst3Runtime) {
        if let Some(native) = self.native.take() {
            native.detach();
        }
        self.warning = None;
        self.native_scale_warning = None;
        match mode {
            PluginEditorMode::Native => {
                if let Err(error) = self.attach_native(runtime) {
                    // The saved preference remains native. This fallback only describes the
                    // currently active view and is not written back to settings.
                    self.warning = Some(match self.refresh_parameters(runtime) {
                        Ok(()) => error,
                        Err(parameter_error) => format!("{error} {parameter_error}"),
                    });
                    self.active_mode = PluginEditorMode::Parameters;
                    self.request_parameter_window_size();
                } else {
                    self.parameters.clear();
                }
            }
            PluginEditorMode::Parameters => {
                if let Err(error) = self.refresh_parameters(runtime) {
                    self.warning = Some(error);
                }
                self.active_mode = PluginEditorMode::Parameters;
                self.request_parameter_window_size();
            }
        }
    }

    pub(crate) fn refresh_parameters(&mut self, runtime: &Vst3Runtime) -> Result<(), String> {
        match runtime.parameters(&self.instance_id) {
            Ok(parameters) => {
                self.parameters = parameters;
                Ok(())
            }
            Err(error) => {
                self.parameters.clear();
                Err(format!("Could not read the plug-in parameters: {error}"))
            }
        }
    }

    fn attach_native(&mut self, runtime: &Vst3Runtime) -> Result<(), String> {
        // Native editors own their preferred content extent. A minimum intended
        // for the parameter editor would otherwise force small plug-ins into an
        // oversized window and leave blank or clipped child-window space.
        self.window.set_min_inner_size(None::<WinitSize>);
        if self.platform_context.is_none() {
            self.platform_context = Some(NativeUiContext::initialize()?);
        }
        let view = runtime.create_view(&self.instance_id)?;
        self.window.set_resizable(view.can_resize());

        // Apply content scale before reading size: some adaptive editors only
        // report a usable getSize after IPlugViewContentScaleSupport.
        let scale = plugin_content_scale(self.monitor_scale.get(), self.user_zoom.get());
        let plugin_scaled = view
            .set_content_scale_factor(scale)
            .map_err(|error| format!("Could not set the plug-in UI scale: {error}"))?;
        let scale_strategy =
            NativeScaleStrategy::resolve(plugin_scaled, self.platform_scale_fallback);
        self.native_scale_warning = native_scale_warning(
            scale_strategy,
            self.monitor_scale.get(),
            self.user_zoom.get(),
            false,
        );

        let size = initial_native_view_rect(view.size(), |rect| view.constrain_size(rect).is_ok());
        let toolbar_height = toolbar_height_for_rect(
            size,
            scale_strategy,
            self.monitor_scale.get(),
            self.user_zoom.get(),
        );
        let toolbar = toolbar_platform_extent(
            toolbar_height,
            self.monitor_scale.get(),
            self.user_zoom.get(),
        );
        let geometry = native_container_geometry(
            size,
            scale_strategy,
            self.monitor_scale.get(),
            self.user_zoom.get(),
            toolbar,
        );
        let Some(container) = NativeContainer::create(
            &self.window,
            geometry,
            scale_strategy.uses_platform_fallback(),
        )?
        else {
            return Err("This display server does not support native VST3 editors; \
                 Wayland currently supports Parameters only."
                .into());
        };
        if !view.supports_platform(container.platform_type()) {
            drop(view);
            drop(container);
            return Err(
                "The plug-in does not support a native editor container on this platform; \
                 switched to Parameters."
                    .into(),
            );
        }

        let container = Rc::new(RefCell::new(container));
        let callback_container = container.clone();
        let callback_window = self.window.clone();
        let callback_monitor_scale = self.monitor_scale.clone();
        let callback_user_zoom = self.user_zoom.clone();
        let callback_scale_strategy = scale_strategy;
        let attached_size = Rc::new(Cell::new(None));
        let callback_attached_size = attached_size.clone();
        let mut frame = PlugFrame::new(move |raw_view, mut requested| {
            let monitor_scale = callback_monitor_scale.get();
            let user_zoom = callback_user_zoom.get();
            let toolbar_height = toolbar_height_for_rect(
                requested,
                callback_scale_strategy,
                monitor_scale,
                user_zoom,
            );
            let toolbar = toolbar_platform_extent(toolbar_height, monitor_scale, user_zoom);
            let geometry = native_container_geometry(
                requested,
                callback_scale_strategy,
                monitor_scale,
                user_zoom,
                toolbar,
            );
            callback_container.borrow_mut().resize(geometry);
            let physical = outer_physical_extent(
                requested,
                callback_scale_strategy,
                monitor_scale,
                user_zoom,
            );
            let _ = callback_window.request_inner_size(WinitSize::Physical(PhysicalSize::new(
                physical.width.max(1),
                physical.height.max(1),
            )));
            let accepted = unsafe {
                // SAFETY: raw_view is the live IPlugView supplied by this frame callback.
                PlugView::on_size_raw(raw_view, &mut requested).is_ok()
            };
            if accepted {
                callback_attached_size.set(Some(requested));
            }
            accepted
        });

        if let Err(error) = unsafe {
            // SAFETY: frame has a stable Box address and is retained through detach.
            view.set_frame(frame.as_interface())
        } {
            return Err(format!(
                "Could not set IPlugFrame for the plug-in UI: {error}"
            ));
        }
        let (attach_handle, platform_type) = {
            let container = container.borrow();
            (container.attach_handle(), container.platform_type())
        };
        let attach_result = with_native_child_scale_context(
            scale_strategy.uses_platform_fallback(),
            || unsafe {
                // SAFETY: the platform child remains owned by the attachment until removed.
                view.attach(attach_handle, platform_type)
            },
        );
        if let Err(error) = attach_result {
            let _ = unsafe {
                // SAFETY: null clears the frame before cleanup of a failed attach.
                view.set_frame(std::ptr::null_mut())
            };
            drop(view);
            drop(frame);
            drop(container);
            return Err(format!("Could not attach the plug-in UI: {error}"));
        }
        // `attached` may synchronously call IPlugFrame::resizeView after the
        // plug-in has applied its content scale. Never overwrite that request
        // with the pre-attach rectangle read above.
        let final_size = attached_size
            .get()
            .or_else(|| view.size().ok())
            .unwrap_or(size);
        let toolbar_height = toolbar_height_for_rect(
            final_size,
            scale_strategy,
            self.monitor_scale.get(),
            self.user_zoom.get(),
        );
        let toolbar = toolbar_platform_extent(
            toolbar_height,
            self.monitor_scale.get(),
            self.user_zoom.get(),
        );
        let geometry = native_container_geometry(
            final_size,
            scale_strategy,
            self.monitor_scale.get(),
            self.user_zoom.get(),
            toolbar,
        );
        container.borrow_mut().resize(geometry);
        let physical = outer_physical_extent(
            final_size,
            scale_strategy,
            self.monitor_scale.get(),
            self.user_zoom.get(),
        );
        let _ = self
            .window
            .request_inner_size(WinitSize::Physical(physical));
        self.native = Some(NativeAttachment {
            view,
            frame,
            container,
            scale_strategy,
        });
        self.active_mode = PluginEditorMode::Native;
        Ok(())
    }

    fn update_native_scale(&mut self) {
        let Some(native) = &self.native else {
            return;
        };
        let factor = plugin_content_scale(self.monitor_scale.get(), self.user_zoom.get());
        let rejected = native.scale_strategy == NativeScaleStrategy::Plugin
            && !matches!(native.view.set_content_scale_factor(factor), Ok(true));
        self.native_scale_warning = native_scale_warning(
            native.scale_strategy,
            self.monitor_scale.get(),
            self.user_zoom.get(),
            rejected,
        );
        self.layout_native_preferred();
    }

    fn layout_native_preferred(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        self.window.set_min_inner_size(None::<WinitSize>);
        let Ok(rect) = native.view.size() else {
            return;
        };
        let monitor_scale = self.monitor_scale.get();
        let user_zoom = self.user_zoom.get();
        let strategy = native.scale_strategy;
        let toolbar_height = toolbar_height_for_rect(rect, strategy, monitor_scale, user_zoom);
        let toolbar = toolbar_platform_extent(toolbar_height, monitor_scale, user_zoom);
        let geometry =
            native_container_geometry(rect, strategy, monitor_scale, user_zoom, toolbar);
        native.container.borrow_mut().resize(geometry);
        let physical = outer_physical_extent(rect, strategy, monitor_scale, user_zoom);
        let _ = self
            .window
            .request_inner_size(WinitSize::Physical(physical));
    }

    fn resize_native_to_window(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        if !native.view.can_resize() {
            return;
        }
        let physical = self.window.inner_size();
        let monitor_scale = self.monitor_scale.get();
        let user_zoom = self.user_zoom.get();
        let toolbar_height = editor_toolbar_height(
            (f64::from(physical.width) / effective_iced_scale(monitor_scale, user_zoom)) as f32,
        );
        let toolbar_physical =
            (toolbar_height * monitor_scale * user_zoom).round() as u32;
        let plugin_physical_height = physical.height.saturating_sub(toolbar_physical).max(1);
        let strategy = native.scale_strategy;
        let mut rect = view_rect_from_physical(
            physical.width.max(1),
            plugin_physical_height,
            strategy,
            monitor_scale,
            user_zoom,
        );
        let _ = native.view.constrain_size(&mut rect);
        let toolbar = toolbar_platform_extent(toolbar_height, monitor_scale, user_zoom);
        let geometry =
            native_container_geometry(rect, strategy, monitor_scale, user_zoom, toolbar);
        native.container.borrow_mut().resize(geometry);
        let _ = native.view.on_size(&mut rect);
    }

    fn request_parameter_window_size(&self) {
        self.window.set_resizable(true);
        let minimum = PhysicalSize::new(
            (MIN_PARAMETER_WIDTH * self.effective_scale()).round() as u32,
            (MIN_PARAMETER_HEIGHT * self.effective_scale()).round() as u32,
        );
        self.window
            .set_min_inner_size(Some(WinitSize::Physical(minimum)));
        let physical = PhysicalSize::new(
            (DEFAULT_PARAMETER_WIDTH * self.effective_scale()).round() as u32,
            (DEFAULT_PARAMETER_HEIGHT * self.effective_scale()).round() as u32,
        );
        let _ = self
            .window
            .request_inner_size(WinitSize::Physical(physical));
    }

    fn resize_surface(&mut self, size: PhysicalSize<u32>, compositor: &mut Compositor) {
        if size.width == 0 || size.height == 0 {
            return;
        }
        compositor.configure_surface(&mut self.surface, size.width, size.height);
        self.viewport = Viewport::with_physical_size(
            Size::new(size.width, size.height),
            self.effective_scale() as f32,
        );
        self.window.request_redraw();
    }

    fn rebuild_viewport(&mut self) {
        let size = self.window.inner_size();
        self.viewport = Viewport::with_physical_size(
            Size::new(size.width.max(1), size.height.max(1)),
            self.effective_scale() as f32,
        );
    }

    fn effective_scale(&self) -> f64 {
        effective_iced_scale(self.monitor_scale.get(), self.user_zoom.get())
    }

    fn close_toolbar_menu(&mut self) {
        self.open_menu = None;
        self.sidechain_menu = None;
    }
}
