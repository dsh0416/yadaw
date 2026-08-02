
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

#[cfg(target_os = "macos")]
fn container_extent(rect: ViewRect, _monitor_scale: f64) -> (u32, u32) {
    (rect_width(rect), rect_height(rect))
}

#[cfg(not(target_os = "macos"))]
fn container_extent(rect: ViewRect, _monitor_scale: f64) -> (u32, u32) {
    (rect_width(rect), rect_height(rect))
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

fn toolbar_height_for_rect(rect: ViewRect, monitor_scale: f64, user_zoom: f64) -> f64 {
    #[cfg(target_os = "macos")]
    let plugin_physical_width = (f64::from(rect_width(rect)) * monitor_scale).round();
    #[cfg(not(target_os = "macos"))]
    let plugin_physical_width = f64::from(rect_width(rect));
    editor_toolbar_height(
        (plugin_physical_width / effective_iced_scale(monitor_scale, user_zoom)) as f32,
    )
}

fn outer_physical_extent(rect: ViewRect, monitor_scale: f64, user_zoom: f64) -> PhysicalSize<u32> {
    #[cfg(target_os = "macos")]
    let (plugin_width, plugin_height) = (
        (f64::from(rect_width(rect)) * monitor_scale).round() as u32,
        (f64::from(rect_height(rect)) * monitor_scale).round() as u32,
    );
    #[cfg(not(target_os = "macos"))]
    let (plugin_width, plugin_height) = (rect_width(rect), rect_height(rect));
    let toolbar_height = toolbar_height_for_rect(rect, monitor_scale, user_zoom);
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
fn view_rect_from_physical(width: u32, height: u32, monitor_scale: f64) -> ViewRect {
    ViewRect {
        left: 0,
        top: 0,
        right: (f64::from(width) / monitor_scale).round() as i32,
        bottom: (f64::from(height) / monitor_scale).round() as i32,
    }
}

#[cfg(not(target_os = "macos"))]
fn view_rect_from_physical(width: u32, height: u32, _monitor_scale: f64) -> ViewRect {
    ViewRect {
        left: 0,
        top: 0,
        right: width as i32,
        bottom: height as i32,
    }
}
