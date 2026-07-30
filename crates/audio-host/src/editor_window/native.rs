impl EditorWindow {
    fn switch_mode(&mut self, mode: PluginEditorMode, runtime: &Vst3Runtime) {
        if let Some(native) = self.native.take() {
            native.detach();
        }
        self.warning = None;
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

    fn refresh_parameters(&mut self, runtime: &Vst3Runtime) -> Result<(), String> {
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
        let scale_supported = view
            .set_content_scale_factor(scale)
            .map_err(|error| format!("Could not set the plug-in UI scale: {error}"))?;
        if !scale_supported {
            self.warning = Some(
                "This plug-in does not support native UI scaling; shell scaling is still applied."
                    .into(),
            );
        }

        let size = initial_native_view_rect(view.size(), |rect| view.constrain_size(rect).is_ok());
        let (container_width, container_height) = container_extent(size, self.monitor_scale.get());
        let toolbar = toolbar_platform_extent(self.monitor_scale.get(), self.user_zoom.get());
        let Some(container) = NativeContainer::create(
            &self.window,
            0,
            container_origin(toolbar),
            container_width,
            container_height,
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
        let attached_size = Rc::new(Cell::new(None));
        let callback_attached_size = attached_size.clone();
        let mut frame = PlugFrame::new(move |raw_view, mut requested| {
            let monitor_scale = callback_monitor_scale.get();
            let user_zoom = callback_user_zoom.get();
            let (width, height) = container_extent(requested, monitor_scale);
            let toolbar = toolbar_platform_extent(monitor_scale, user_zoom);
            callback_container
                .borrow_mut()
                .resize(0, container_origin(toolbar), width, height);
            let physical = outer_physical_extent(requested, monitor_scale, user_zoom);
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
        if let Err(error) = unsafe {
            // SAFETY: the platform child remains owned by the attachment until removed.
            view.attach(attach_handle, platform_type)
        } {
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
        let (final_width, final_height) = container_extent(final_size, self.monitor_scale.get());
        let toolbar = toolbar_platform_extent(self.monitor_scale.get(), self.user_zoom.get());
        container
            .borrow_mut()
            .resize(0, container_origin(toolbar), final_width, final_height);
        let physical =
            outer_physical_extent(final_size, self.monitor_scale.get(), self.user_zoom.get());
        let _ = self
            .window
            .request_inner_size(WinitSize::Physical(physical));
        self.native = Some(NativeAttachment {
            view,
            frame,
            container,
            scale_supported,
        });
        self.set_native_visible(self.open_menu.is_none());
        self.active_mode = PluginEditorMode::Native;
        Ok(())
    }

    fn update_native_scale(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        let factor = plugin_content_scale(self.monitor_scale.get(), self.user_zoom.get());
        match native.view.set_content_scale_factor(factor) {
            Ok(true) => native.scale_supported = true,
            Ok(false) | Err(_) => {
                native.scale_supported = false;
                self.warning = Some(
                    "This plug-in does not support native UI scaling; \
                     shell scaling is still applied."
                        .into(),
                );
            }
        }
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
        let (width, height) = container_extent(rect, monitor_scale);
        let toolbar = toolbar_platform_extent(monitor_scale, user_zoom);
        native
            .container
            .borrow_mut()
            .resize(0, container_origin(toolbar), width, height);
        let physical = outer_physical_extent(rect, monitor_scale, user_zoom);
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
        let toolbar_physical = (TOOLBAR_HEIGHT * monitor_scale * user_zoom).round() as u32;
        let plugin_physical_height = physical.height.saturating_sub(toolbar_physical).max(1);
        let mut rect =
            view_rect_from_physical(physical.width.max(1), plugin_physical_height, monitor_scale);
        let _ = native.view.constrain_size(&mut rect);
        let (width, height) = container_extent(rect, monitor_scale);
        let toolbar = toolbar_platform_extent(monitor_scale, user_zoom);
        native
            .container
            .borrow_mut()
            .resize(0, container_origin(toolbar), width, height);
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

    fn set_native_visible(&self, visible: bool) {
        if let Some(native) = &self.native {
            native.container.borrow().set_visible(visible);
        }
    }

    fn close_toolbar_menu(&mut self) {
        self.open_menu = None;
        self.set_native_visible(true);
    }
}
