
impl Drop for EditorWindow {
    fn drop(&mut self) {
        self.close();
    }
}

fn parameter_step(step_count: i32) -> f64 {
    if step_count > 0 {
        1.0 / f64::from(step_count)
    } else {
        0.001
    }
}

fn effective_iced_scale(monitor_scale: f64, user_zoom: f64) -> f64 {
    (monitor_scale * user_zoom).max(0.01)
}

fn is_narrow_toolbar(logical_width: f32) -> bool {
    logical_width < TOOLBAR_NARROW_BREAKPOINT
}

fn editor_toolbar_height(logical_width: f32) -> f64 {
    if is_narrow_toolbar(logical_width) {
        TOOLBAR_HEIGHT_NARROW
    } else {
        TOOLBAR_HEIGHT_WIDE
    }
}

#[cfg(target_os = "macos")]
fn plugin_content_scale(_monitor_scale: f64, user_zoom: f64) -> f32 {
    user_zoom as f32
}

#[cfg(not(target_os = "macos"))]
fn plugin_content_scale(monitor_scale: f64, user_zoom: f64) -> f32 {
    (monitor_scale * user_zoom) as f32
}

fn native_scale_warning(
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
    plugin_rejected: bool,
) -> Option<String> {
    if plugin_rejected {
        return Some(
            "The plug-in rejected the requested UI scale; the previous native scale is still active."
                .into(),
        );
    }

    #[cfg(target_os = "windows")]
    if strategy == NativeScaleStrategy::Platform && (user_zoom - 1.0).abs() > f64::EPSILON {
        return Some(
            "Windows compatibility scaling is applied to the plug-in UI; custom Zoom is unavailable for this plug-in."
                .into(),
        );
    }

    if strategy == NativeScaleStrategy::Unscaled
        && (f64::from(plugin_content_scale(monitor_scale, user_zoom)) - 1.0).abs() > f64::EPSILON
    {
        return Some(
            "This plug-in cannot be scaled by the host on this platform; its native size is preserved."
                .into(),
        );
    }

    None
}

fn rect_width(rect: ViewRect) -> u32 {
    rect.right.saturating_sub(rect.left).max(0) as u32
}

fn rect_height(rect: ViewRect) -> u32 {
    rect.bottom.saturating_sub(rect.top).max(0) as u32
}

fn default_native_view_rect() -> ViewRect {
    ViewRect {
        left: 0,
        top: 0,
        right: DEFAULT_NATIVE_EDITOR_WIDTH,
        bottom: DEFAULT_NATIVE_EDITOR_HEIGHT,
    }
}

/// Resolve the initial plug-in content rect for window creation.
///
/// Adaptive UIs often return an error or empty rect from `getSize` until they
/// are attached and call `IPlugFrame::resizeView`. In that case use a default
/// size (optionally constrained) so attach can proceed.
fn initial_native_view_rect(
    reported: Result<ViewRect, impl std::fmt::Display>,
    mut constrain: impl FnMut(&mut ViewRect) -> bool,
) -> ViewRect {
    if let Ok(size) = reported
        && rect_width(size) > 0
        && rect_height(size) > 0
    {
        return size;
    }
    let mut fallback = default_native_view_rect();
    if constrain(&mut fallback) && rect_width(fallback) > 0 && rect_height(fallback) > 0 {
        return fallback;
    }
    default_native_view_rect()
}

fn platform_frame_scale(
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
) -> f64 {
    platform_frame_scale_for(
        strategy,
        monitor_scale,
        user_zoom,
        cfg!(target_os = "macos"),
        cfg!(target_os = "windows"),
    )
}

fn platform_frame_scale_for(
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
    is_macos: bool,
    is_windows: bool,
) -> f64 {
    if !strategy.uses_platform_fallback() {
        1.0
    } else if is_macos {
        user_zoom
    } else if is_windows {
        monitor_scale
    } else {
        1.0
    }
}

fn container_extent(
    rect: ViewRect,
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
) -> (u32, u32) {
    let scale = platform_frame_scale(strategy, monitor_scale, user_zoom);
    (
        (f64::from(rect_width(rect)) * scale).round() as u32,
        (f64::from(rect_height(rect)) * scale).round() as u32,
    )
}

fn content_extent(rect: ViewRect) -> (u32, u32) {
    (rect_width(rect), rect_height(rect))
}

fn native_container_geometry(
    rect: ViewRect,
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
    toolbar: u32,
) -> NativeContainerGeometry {
    let (frame_width, frame_height) =
        container_extent(rect, strategy, monitor_scale, user_zoom);
    let (content_width, content_height) = content_extent(rect);
    NativeContainerGeometry {
        x: 0,
        y: container_origin(toolbar),
        frame_width,
        frame_height,
        content_width,
        content_height,
    }
}

#[cfg(target_os = "macos")]
fn toolbar_platform_extent(
    toolbar_height: f64,
    monitor_scale: f64,
    user_zoom: f64,
) -> u32 {
    let _ = monitor_scale;
    (toolbar_height * user_zoom).round() as u32
}

#[cfg(not(target_os = "macos"))]
fn toolbar_platform_extent(
    toolbar_height: f64,
    monitor_scale: f64,
    user_zoom: f64,
) -> u32 {
    (toolbar_height * monitor_scale * user_zoom).round() as u32
}

fn container_origin(toolbar: u32) -> i32 {
    toolbar as i32
}

fn toolbar_height_for_rect(
    rect: ViewRect,
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
) -> f64 {
    let (frame_width, _) = container_extent(rect, strategy, monitor_scale, user_zoom);
    #[cfg(target_os = "macos")]
    let plugin_physical_width = (f64::from(frame_width) * monitor_scale).round();
    #[cfg(not(target_os = "macos"))]
    let plugin_physical_width = f64::from(frame_width);
    editor_toolbar_height(
        (plugin_physical_width / effective_iced_scale(monitor_scale, user_zoom)) as f32,
    )
}

fn outer_physical_extent(
    rect: ViewRect,
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
) -> PhysicalSize<u32> {
    let (frame_width, frame_height) =
        container_extent(rect, strategy, monitor_scale, user_zoom);
    #[cfg(target_os = "macos")]
    let (plugin_width, plugin_height) = (
        (f64::from(frame_width) * monitor_scale).round() as u32,
        (f64::from(frame_height) * monitor_scale).round() as u32,
    );
    #[cfg(not(target_os = "macos"))]
    let (plugin_width, plugin_height) = (frame_width, frame_height);
    let toolbar_height = toolbar_height_for_rect(rect, strategy, monitor_scale, user_zoom);
    PhysicalSize::new(
        plugin_width.max(1),
        plugin_height
            .saturating_add(
                (toolbar_height * monitor_scale * user_zoom).round() as u32,
            )
            .max(1),
    )
}

#[cfg(target_os = "macos")]
fn view_rect_from_physical(
    width: u32,
    height: u32,
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
) -> ViewRect {
    let scale = monitor_scale * platform_frame_scale(strategy, monitor_scale, user_zoom);
    ViewRect {
        left: 0,
        top: 0,
        right: (f64::from(width) / scale).round() as i32,
        bottom: (f64::from(height) / scale).round() as i32,
    }
}

#[cfg(not(target_os = "macos"))]
fn view_rect_from_physical(
    width: u32,
    height: u32,
    strategy: NativeScaleStrategy,
    monitor_scale: f64,
    user_zoom: f64,
) -> ViewRect {
    let scale = platform_frame_scale(strategy, monitor_scale, user_zoom);
    ViewRect {
        left: 0,
        top: 0,
        right: (f64::from(width) / scale).round() as i32,
        bottom: (f64::from(height) / scale).round() as i32,
    }
}
