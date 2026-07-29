#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuous_and_discrete_parameter_steps_are_distinct() {
        assert_eq!(parameter_step(0), 0.001);
        assert_eq!(parameter_step(4), 0.25);
    }

    #[test]
    fn iced_scale_multiplies_monitor_and_user_zoom() {
        assert_eq!(effective_iced_scale(1.5, 1.25), 1.875);
    }

    #[test]
    fn zoom_boundaries_are_representable() {
        assert_eq!(effective_iced_scale(1.0, 0.5), 0.5);
        assert_eq!(effective_iced_scale(1.0, 4.0), 4.0);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn windows_and_x11_use_physical_view_rects() {
        assert_eq!(view_rect_from_physical(900, 600, 1.5).right, 900);
        assert_eq!(plugin_content_scale(1.5, 1.25), 1.875);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn native_outer_extent_keeps_the_attached_plugin_pixel_size() {
        let attached = ViewRect {
            left: 0,
            top: 0,
            right: 525,
            bottom: 180,
        };
        assert_eq!(
            outer_physical_extent(attached, 1.5, 1.0),
            PhysicalSize::new(525, 288)
        );
    }

    #[test]
    fn toolbar_dropdown_options_have_compact_labels() {
        assert_eq!(EditorModeOption::Native.to_string(), "Plug-in UI");
        assert_eq!(EditorModeOption::Parameters.to_string(), "Parameters");
        assert_eq!(ZoomOption(125).to_string(), "125%");
    }
}
