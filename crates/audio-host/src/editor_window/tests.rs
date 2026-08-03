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

    #[test]
    fn native_container_starts_below_toolbar_on_every_platform() {
        assert_eq!(container_origin(72), 72);
    }

    #[test]
    fn narrow_editors_gain_a_second_command_row() {
        assert_eq!(editor_toolbar_height(519.0), TOOLBAR_HEIGHT_NARROW);
        assert_eq!(editor_toolbar_height(520.0), TOOLBAR_HEIGHT_WIDE);
    }

    #[test]
    fn compare_segments_are_equal_width_on_the_compact_grid() {
        assert_eq!(COMPARE_SEGMENT_WIDTH % ui_space::XS, 0.0);
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
            PhysicalSize::new(525, 324)
        );
    }

    #[test]
    fn toolbar_zoom_options_have_compact_labels() {
        assert_eq!(ZoomOption(125).to_string(), "125%");
    }

    #[test]
    fn zoom_picker_includes_supported_boundaries() {
        let options = zoom_options(100);
        assert_eq!(options.first(), Some(&ZoomOption(50)));
        assert_eq!(options.last(), Some(&ZoomOption(400)));
    }

    #[test]
    fn zoom_picker_keeps_a_non_preset_current_value_visible() {
        let options = zoom_options(225);
        assert!(options.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert_eq!(
            options
                .iter()
                .filter(|option| **option == ZoomOption(225))
                .count(),
            1
        );
    }

    #[test]
    fn signal_colors_accept_six_digit_hex() {
        assert_eq!(
            parse_signal_color("#58c6c2"),
            Some(Color::from_rgb8(0x58, 0xc6, 0xc2))
        );
        assert_eq!(parse_signal_color("58c6c2"), None);
    }

    #[test]
    fn parameter_history_discards_the_oldest_entry() {
        let mut history = VecDeque::new();
        for parameter_id in 0..=PARAMETER_HISTORY_LIMIT as u32 {
            push_parameter_edit(
                &mut history,
                ParameterEdit {
                    parameter_id,
                    before: 0.0,
                    after: 1.0,
                },
            );
        }
        assert_eq!(history.len(), PARAMETER_HISTORY_LIMIT);
        assert_eq!(history.front().map(|edit| edit.parameter_id), Some(1));
    }

    #[test]
    fn initial_native_view_rect_keeps_reported_sizes() {
        let reported: Result<ViewRect, &str> = Ok(ViewRect {
            left: 0,
            top: 0,
            right: 640,
            bottom: 480,
        });
        let size = initial_native_view_rect(reported, |_| true);
        assert_eq!((rect_width(size), rect_height(size)), (640, 480));
    }

    #[test]
    fn initial_native_view_rect_falls_back_when_get_size_fails() {
        let size = initial_native_view_rect(Err("not ready"), |_| true);
        assert_eq!(
            (rect_width(size), rect_height(size)),
            (
                DEFAULT_NATIVE_EDITOR_WIDTH as u32,
                DEFAULT_NATIVE_EDITOR_HEIGHT as u32
            )
        );
    }

    #[test]
    fn initial_native_view_rect_falls_back_when_size_is_empty() {
        let reported: Result<ViewRect, &str> = Ok(ViewRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        });
        let size = initial_native_view_rect(reported, |rect| {
            rect.right = 1024;
            rect.bottom = 768;
            true
        });
        assert_eq!((rect_width(size), rect_height(size)), (1024, 768));
    }
}

#[test]
fn editor_clipboard_accepts_only_the_same_vst3_class() {
    let clipboard = EditorClipboard {
        class_id: "same-class".to_owned(),
        state: EditorPluginState {
            component_state: vec![1, 2],
            controller_state: vec![3, 4],
        },
    };
    assert!(clipboard.supports("same-class"));
    assert!(!clipboard.supports("different-class"));
}

#[test]
fn compare_slots_have_stable_state_indices() {
    assert_eq!(CompareSlot::A.index(), 0);
    assert_eq!(CompareSlot::B.index(), 1);
}

#[test]
fn failed_compare_restore_preserves_both_saved_slots() {
    let original = [
        EditorPluginState {
            component_state: vec![1],
            controller_state: vec![2],
        },
        EditorPluginState {
            component_state: vec![3],
            controller_state: vec![4],
        },
    ];
    let mut slots = original.clone();
    let live = EditorPluginState {
        component_state: vec![5],
        controller_state: vec![6],
    };

    let result = restore_compare_slot(
        &mut slots,
        CompareSlot::A,
        CompareSlot::B,
        live,
        |_| Err("restore failed".to_owned()),
    );

    assert_eq!(result, Err("restore failed".to_owned()));
    assert_eq!(slots, original);
}

#[test]
fn pasted_state_replaces_only_the_active_compare_slot() {
    let untouched = EditorPluginState {
        component_state: vec![3],
        controller_state: vec![4],
    };
    let mut slots = Some([
        EditorPluginState {
            component_state: vec![1],
            controller_state: vec![2],
        },
        untouched.clone(),
    ]);
    let pasted = EditorPluginState {
        component_state: vec![5],
        controller_state: vec![6],
    };

    update_active_compare_slot(&mut slots, CompareSlot::A, pasted.clone());

    assert_eq!(slots, Some([pasted, untouched]));
}

#[test]
fn pasted_state_is_safe_when_comparison_is_unavailable() {
    let mut slots = None;
    update_active_compare_slot(
        &mut slots,
        CompareSlot::B,
        EditorPluginState {
            component_state: vec![1],
            controller_state: vec![2],
        },
    );
    assert_eq!(slots, None);
}
