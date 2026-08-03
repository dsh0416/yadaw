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
    fn native_scale_strategy_prefers_plugin_then_platform() {
        assert_eq!(
            NativeScaleStrategy::resolve(true, true),
            NativeScaleStrategy::Plugin
        );
        assert_eq!(
            NativeScaleStrategy::resolve(false, true),
            NativeScaleStrategy::Platform
        );
        assert_eq!(
            NativeScaleStrategy::resolve(false, false),
            NativeScaleStrategy::Unscaled
        );
    }

    #[test]
    fn platform_fallback_scales_only_for_the_platforms_that_support_it() {
        assert_eq!(
            platform_frame_scale_for(
                NativeScaleStrategy::Platform,
                2.0,
                1.5,
                true,
                false
            ),
            1.5
        );
        assert_eq!(
            platform_frame_scale_for(
                NativeScaleStrategy::Platform,
                2.0,
                1.5,
                false,
                true
            ),
            2.0
        );
        assert_eq!(
            platform_frame_scale_for(
                NativeScaleStrategy::Platform,
                2.0,
                1.5,
                false,
                false
            ),
            1.0
        );
        assert_eq!(
            platform_frame_scale_for(
                NativeScaleStrategy::Plugin,
                2.0,
                1.5,
                true,
                false
            ),
            1.0
        );
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
        assert_eq!(
            view_rect_from_physical(
                900,
                600,
                NativeScaleStrategy::Plugin,
                1.5,
                1.25
            )
            .right,
            900
        );
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
            outer_physical_extent(attached, NativeScaleStrategy::Plugin, 1.5, 1.0),
            PhysicalSize::new(525, 324)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn appkit_fallback_scales_frame_but_preserves_plugin_coordinates() {
        let attached = ViewRect {
            left: 0,
            top: 0,
            right: 500,
            bottom: 200,
        };
        assert_eq!(content_extent(attached), (500, 200));
        assert_eq!(
            container_extent(attached, NativeScaleStrategy::Platform, 2.0, 1.5),
            (750, 300)
        );
        assert_eq!(
            outer_physical_extent(attached, NativeScaleStrategy::Platform, 2.0, 1.5).width,
            1500
        );
        let recovered = view_rect_from_physical(
            1500,
            600,
            NativeScaleStrategy::Platform,
            2.0,
            1.5,
        );
        assert_eq!(recovered.right, attached.right);
        assert_eq!(recovered.bottom, attached.bottom);
    }

    #[test]
    fn identity_scale_does_not_warn_when_native_scaling_is_unavailable() {
        assert_eq!(
            native_scale_warning(NativeScaleStrategy::Unscaled, 1.0, 1.0, false),
            None
        );
    }

    #[test]
    fn native_scale_warnings_distinguish_rejection_and_unscaled_fallback() {
        assert!(
            native_scale_warning(NativeScaleStrategy::Plugin, 2.0, 1.5, true)
                .is_some_and(|warning| warning.contains("rejected"))
        );
        assert!(
            native_scale_warning(NativeScaleStrategy::Unscaled, 2.0, 1.5, false)
                .is_some_and(|warning| warning.contains("native size"))
        );
        assert_eq!(
            native_scale_warning(NativeScaleStrategy::Plugin, 2.0, 1.5, false),
            None
        );
    }

    #[test]
    fn native_container_geometry_separates_frame_and_plugin_content() {
        let rect = ViewRect {
            left: 10,
            top: 20,
            right: 410,
            bottom: 220,
        };

        let geometry = native_container_geometry(
            rect,
            NativeScaleStrategy::Platform,
            2.0,
            1.5,
            72,
        );

        assert_eq!(geometry.x, 0);
        assert_eq!(geometry.y, 72);
        assert_eq!((geometry.content_width, geometry.content_height), (400, 200));
        #[cfg(target_os = "macos")]
        assert_eq!((geometry.frame_width, geometry.frame_height), (600, 300));
        #[cfg(not(target_os = "macos"))]
        assert_eq!((geometry.frame_width, geometry.frame_height), (800, 400));
    }

    #[test]
    fn editor_context_updates_preserve_missing_identity_fields() {
        let mut current = PluginEditorContext {
            channel_name: "Track 1".to_owned(),
            channel_color: "#111111".to_owned(),
            plugin_name: "Old".to_owned(),
            appearance: PluginEditorAppearance::default(),
        };
        let appearance = PluginEditorAppearance {
            theme: PluginEditorTheme::Light,
            locale: PluginEditorLocale::ZhCmnHansCn,
        };

        merge_editor_context(
            &mut current,
            PluginEditorContext {
                channel_name: String::new(),
                channel_color: "#222222".to_owned(),
                plugin_name: "New".to_owned(),
                appearance,
            },
        );

        assert_eq!(current.channel_name, "Track 1");
        assert_eq!(current.channel_color, "#222222");
        assert_eq!(current.plugin_name, "New");
        assert_eq!(current.appearance, appearance);
    }

    #[test]
    fn toolbar_choice_actions_ignore_current_values_and_preserve_other_fields() {
        let preference = PluginEditorPreference {
            mode: PluginEditorMode::Native,
            zoom_percent: 125,
        };

        assert!(toolbar_choice_action(
            preference,
            ToolbarMenuChoice::Mode(PluginEditorMode::Native)
        )
        .is_none());
        assert!(toolbar_choice_action(preference, ToolbarMenuChoice::Zoom(125)).is_none());
        assert!(matches!(
            toolbar_choice_action(
                preference,
                ToolbarMenuChoice::Mode(PluginEditorMode::Parameters)
            ),
            Some(EditorAction::PreferenceChanged(PluginEditorPreference {
                mode: PluginEditorMode::Parameters,
                zoom_percent: 125,
            }))
        ));
        assert!(matches!(
            toolbar_choice_action(preference, ToolbarMenuChoice::Zoom(200)),
            Some(EditorAction::PreferenceChanged(PluginEditorPreference {
                mode: PluginEditorMode::Native,
                zoom_percent: 200,
            }))
        ));
        assert_eq!(
            popup_failure_message("surface lost"),
            "Could not open the toolbar menu: surface lost. Try again."
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
    fn toolbar_menu_opens_downward_when_space_is_available() {
        let geometry = toolbar_menu_geometry(
            Rectangle::new(Point::new(600.0, 40.0), Size::new(112.0, 24.0)),
            2,
            PhysicalPosition::new(100, 200),
            PhysicalSize::new(800, 600),
            1.0,
        );

        assert!(!geometry.opens_upward);
        assert_eq!(geometry.position, PhysicalPosition::new(700, 264));
        assert_eq!(geometry.size, PhysicalSize::new(112, 56));
        assert_eq!(geometry.visible_rows, 2);
    }

    #[test]
    fn toolbar_menu_opens_upward_near_the_editor_bottom() {
        let geometry = toolbar_menu_geometry(
            Rectangle::new(Point::new(20.0, 560.0), Size::new(72.0, 24.0)),
            10,
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(800, 600),
            1.0,
        );

        assert!(geometry.opens_upward);
        assert_eq!(geometry.position.y, 312);
        assert_eq!(geometry.size.height, 248);
        assert_eq!(geometry.visible_rows, 10);
    }

    #[test]
    fn toolbar_menu_limits_height_and_enables_scrolling_at_edges() {
        let geometry = toolbar_menu_geometry(
            Rectangle::new(Point::new(20.0, 40.0), Size::new(72.0, 24.0)),
            10,
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(120, 100),
            1.0,
        );

        assert!(geometry.opens_upward);
        assert_eq!(geometry.size.height, 40);
        assert_eq!(geometry.visible_rows, 1);
    }

    #[test]
    fn toolbar_menu_geometry_converts_hidpi_and_user_zoom_once() {
        let geometry = toolbar_menu_geometry(
            Rectangle::new(Point::new(180.0, 20.0), Size::new(72.0, 24.0)),
            10,
            PhysicalPosition::new(30, 40),
            PhysicalSize::new(400, 300),
            2.0,
        );

        assert_eq!(geometry.position.x, 286);
        assert_eq!(geometry.position.y, 128);
        assert_eq!(geometry.size.width, 144);
        assert_eq!(geometry.visible_rows, 4);
    }

    #[test]
    fn toolbar_menu_keyboard_navigation_wraps_and_reaches_boundaries() {
        let mut highlighted = 0;

        assert_eq!(
            toolbar_menu_key(&Key::Named(NamedKey::ArrowUp), &mut highlighted, 4),
            MenuKeyResult::None
        );
        assert_eq!(highlighted, 3);
        toolbar_menu_key(&Key::Named(NamedKey::Home), &mut highlighted, 4);
        assert_eq!(highlighted, 0);
        toolbar_menu_key(&Key::Named(NamedKey::End), &mut highlighted, 4);
        assert_eq!(highlighted, 3);
        toolbar_menu_key(&Key::Named(NamedKey::ArrowDown), &mut highlighted, 4);
        assert_eq!(highlighted, 0);
    }

    #[test]
    fn toolbar_menu_keyboard_selection_and_cancellation_are_typed() {
        let mut highlighted = 0;

        for key in [NamedKey::Enter, NamedKey::Space] {
            assert_eq!(
                toolbar_menu_key(&Key::Named(key), &mut highlighted, 2),
                MenuKeyResult::Select
            );
        }
        for key in [NamedKey::Escape, NamedKey::Tab] {
            assert_eq!(
                toolbar_menu_key(&Key::Named(key), &mut highlighted, 2),
                MenuKeyResult::Dismiss
            );
        }
    }

    #[test]
    fn macos_popup_ignores_synthetic_focus_loss_after_real_focus() {
        let mut focus = MenuFocusState::new(true);

        assert!(!focus.should_dismiss(true));
        assert!(!focus.should_dismiss(false));
        assert!(focus.should_dismiss(false));
    }

    #[test]
    fn macos_popup_ignores_synthetic_focus_loss_before_real_focus() {
        let mut focus = MenuFocusState::new(true);

        assert!(!focus.should_dismiss(false));
        assert!(!focus.should_dismiss(true));
        assert!(focus.should_dismiss(false));
    }

    #[test]
    fn other_platform_popups_dismiss_on_the_first_focus_loss() {
        let mut focus = MenuFocusState::new(false);

        assert!(focus.should_dismiss(false));
    }

    #[test]
    fn toolbar_menu_initially_highlights_the_current_typed_choice() {
        let options = vec![
            ToolbarMenuOption {
                choice: ToolbarMenuChoice::Zoom(100),
                label: "100%".to_owned(),
            },
            ToolbarMenuOption {
                choice: ToolbarMenuChoice::Zoom(225),
                label: "225%".to_owned(),
            },
        ];

        assert_eq!(
            initial_toolbar_highlight(&options, ToolbarMenuChoice::Zoom(225)),
            1
        );
    }

    #[test]
    fn toolbar_menu_highlight_falls_back_for_absent_and_empty_choices() {
        let options = vec![ToolbarMenuOption {
            choice: ToolbarMenuChoice::Zoom(100),
            label: "100%".to_owned(),
        }];

        assert_eq!(
            initial_toolbar_highlight(&options, ToolbarMenuChoice::Zoom(200)),
            0
        );
        assert_eq!(
            initial_toolbar_highlight(&[], ToolbarMenuChoice::Zoom(100)),
            0
        );
    }

    #[test]
    fn toolbar_menu_ignores_navigation_when_there_are_no_options() {
        let mut highlighted = 0;

        assert_eq!(
            toolbar_menu_key(&Key::Named(NamedKey::ArrowDown), &mut highlighted, 0),
            MenuKeyResult::None
        );
        assert_eq!(
            toolbar_menu_key(&Key::Character("x".into()), &mut highlighted, 3),
            MenuKeyResult::None
        );
        assert_eq!(highlighted, 0);
    }

    #[test]
    fn toolbar_menu_view_builds_selected_and_highlighted_rows() {
        let options = vec![
            ToolbarMenuOption {
                choice: ToolbarMenuChoice::Mode(PluginEditorMode::Native),
                label: "Editor".to_owned(),
            },
            ToolbarMenuOption {
                choice: ToolbarMenuChoice::Mode(PluginEditorMode::Parameters),
                label: "Parameters".to_owned(),
            },
        ];
        let (menu, mut state) = EditorMenuState::new(ToolbarMenuRequest {
            menu: ToolbarMenu::Mode,
            anchor: Rectangle::default(),
            options,
            selected: ToolbarMenuChoice::Mode(PluginEditorMode::Native),
            appearance: Appearance::Dark,
            effective_scale: 2.0,
        });

        assert_eq!(menu, ToolbarMenu::Mode);
        assert_eq!(state.highlighted, 0);
        state.cursor_moved(PhysicalPosition::new(100.0, 50.0));
        assert_eq!(state.cursor, Cursor::Available(Point::new(50.0, 25.0)));
        state.modifiers_changed(ModifiersState::SHIFT);
        assert_eq!(state.modifiers, ModifiersState::SHIFT);
        assert_eq!(
            state.key_pressed(&Key::Named(NamedKey::ArrowDown)),
            None
        );
        assert_eq!(state.highlighted, 1);
        assert_eq!(
            state.key_pressed(&Key::Named(NamedKey::Enter)),
            Some(EditorMenuAction::Selected(ToolbarMenuChoice::Mode(
                PluginEditorMode::Parameters
            )))
        );
        assert_eq!(state.select(99), None);
        state.cursor_left();
        assert_eq!(state.cursor, Cursor::Unavailable);
        state.focus = MenuFocusState::new(false);
        assert_eq!(state.focus_changed(true), None);
        assert_eq!(state.focus_changed(false), Some(EditorMenuAction::Dismiss));
        assert_eq!(
            state.key_pressed(&Key::Named(NamedKey::Escape)),
            Some(EditorMenuAction::Dismiss)
        );

        let view = state.view();

        drop(view);
    }

    #[test]
    fn toolbar_menu_geometry_clamps_oversized_and_offscreen_anchors() {
        let geometry = toolbar_menu_geometry(
            Rectangle::new(Point::new(-40.0, -20.0), Size::new(500.0, 24.0)),
            0,
            PhysicalPosition::new(10, 20),
            PhysicalSize::new(120, 80),
            1.0,
        );

        assert_eq!(geometry.position, PhysicalPosition::new(10, 24));
        assert_eq!(geometry.size.width, 120);
        assert_eq!(geometry.visible_rows, 1);
        assert!(!geometry.opens_upward);
    }

    #[test]
    fn toolbar_menu_requests_keep_typed_mode_zoom_and_localization() {
        let anchor = Rectangle::new(Point::new(12.0, 24.0), Size::new(72.0, 24.0));
        let appearance = PluginEditorAppearance {
            theme: PluginEditorTheme::Light,
            locale: PluginEditorLocale::ZhCmnHansCn,
        };

        let mode = toolbar_menu_request_for(
            ToolbarMenu::Mode,
            anchor,
            PluginEditorMode::Parameters,
            225,
            appearance,
            1.5,
        );
        assert_eq!(
            mode.selected,
            ToolbarMenuChoice::Mode(PluginEditorMode::Parameters)
        );
        assert_eq!(mode.options[0].label, "编辑器");
        assert_eq!(mode.options[1].label, "参数");
        assert_eq!(mode.appearance, Appearance::Light);
        assert_eq!(mode.effective_scale, 1.5);

        let zoom = toolbar_menu_request_for(
            ToolbarMenu::Zoom,
            anchor,
            PluginEditorMode::Native,
            225,
            appearance,
            2.0,
        );
        assert_eq!(zoom.selected, ToolbarMenuChoice::Zoom(225));
        assert!(zoom.options.iter().any(|option| {
            option.choice == ToolbarMenuChoice::Zoom(225) && option.label == "225%"
        }));
    }

    fn editor_view_model(
        active_mode: PluginEditorMode,
        appearance: PluginEditorAppearance,
        parameters: Vec<PluginParameter>,
    ) -> EditorViewModel {
        EditorViewModel {
            context: PluginEditorContext {
                channel_name: "Lead".to_owned(),
                channel_color: "#58c6c2".to_owned(),
                plugin_name: "Test plug-in".to_owned(),
                appearance,
            },
            zoom_percent: 125,
            toolbar_height: TOOLBAR_HEIGHT_WIDE as f32,
            narrow_toolbar: false,
            active_mode,
            open_menu: None,
            warning: None,
            parameters,
            compare_slot: CompareSlot::A,
            can_compare: true,
            can_paste: true,
            can_undo: true,
            can_redo: false,
        }
    }

    #[test]
    fn editor_interactions_emit_typed_toolbar_and_command_actions() {
        let preference = PluginEditorPreference {
            mode: PluginEditorMode::Native,
            zoom_percent: 100,
        };
        let mut compare_segment_focused = true;
        let mut open_menu = Some(ToolbarMenu::Zoom);
        let mut toolbar_anchors = HashMap::new();
        let mut parameters = Vec::new();
        let mut active_gestures = HashSet::new();
        let mut state = EditorInteractionState {
            preference,
            active_mode: PluginEditorMode::Native,
            appearance: PluginEditorAppearance::default(),
            effective_scale: 1.5,
            logical_size: Size::new(640.0, 480.0),
            cursor: Cursor::Available(Point::new(200.0, 100.0)),
            compare_segment_focused: &mut compare_segment_focused,
            open_menu: &mut open_menu,
            toolbar_anchors: &mut toolbar_anchors,
            parameters: &mut parameters,
            active_gestures: &mut active_gestures,
        };
        let mut actions = Vec::new();

        state.update(Message::UseMode(PluginEditorMode::Native), &mut actions);
        assert!(actions.is_empty());
        assert!(!*state.compare_segment_focused);
        assert_eq!(*state.open_menu, None);

        state.update(Message::UseMode(PluginEditorMode::Parameters), &mut actions);
        assert!(matches!(
            actions.as_slice(),
            [EditorAction::PreferenceChanged(PluginEditorPreference {
                mode: PluginEditorMode::Parameters,
                zoom_percent: 100,
            })]
        ));
        actions.clear();

        state.update(Message::UseCompareSlot(CompareSlot::B), &mut actions);
        assert!(*state.compare_segment_focused);
        assert!(matches!(
            actions.as_slice(),
            [EditorAction::UseCompareSlot(CompareSlot::B)]
        ));
        actions.clear();

        for (message, expected) in [
            (Message::CopyState, "copy"),
            (Message::PasteState, "paste"),
            (Message::Undo, "undo"),
            (Message::Redo, "redo"),
        ] {
            state.update(message, &mut actions);
            assert!(matches!(
                (actions.as_slice(), expected),
                ([EditorAction::CopyState], "copy")
                    | ([EditorAction::PasteState], "paste")
                    | ([EditorAction::Undo], "undo")
                    | ([EditorAction::Redo], "redo")
            ));
            actions.clear();
        }

        state.update(Message::ZoomPreset(175), &mut actions);
        assert!(matches!(
            actions.as_slice(),
            [EditorAction::PreferenceChanged(PluginEditorPreference {
                mode: PluginEditorMode::Native,
                zoom_percent: 175,
            })]
        ));
        actions.clear();

        state.update(
            Message::ToolbarTriggerHovered(ToolbarMenu::Mode, Point::new(5.0, 6.0)),
            &mut actions,
        );
        assert_eq!(
            state.toolbar_anchors.get(&ToolbarMenu::Mode),
            Some(&Rectangle::new(
                Point::new(195.0, 94.0),
                Size::new(112.0, yadaw_iced_ui::CONTROL_COMPACT),
            ))
        );
        state.update(Message::OpenToolbarMenu(ToolbarMenu::Mode), &mut actions);
        assert_eq!(*state.open_menu, Some(ToolbarMenu::Mode));
        assert!(matches!(
            actions.as_slice(),
            [EditorAction::OpenToolbarMenu(request)]
                if request.anchor.x == 195.0 && request.menu == ToolbarMenu::Mode
        ));
        actions.clear();

        state.cursor = Cursor::Unavailable;
        state.update(
            Message::ToolbarTriggerHovered(ToolbarMenu::Zoom, Point::new(1.0, 1.0)),
            &mut actions,
        );
        assert!(!state.toolbar_anchors.contains_key(&ToolbarMenu::Zoom));
        state.update(Message::OpenToolbarMenu(ToolbarMenu::Zoom), &mut actions);
        assert!(matches!(
            actions.as_slice(),
            [EditorAction::OpenToolbarMenu(request)]
                if request.anchor == fallback_toolbar_anchor(state.logical_size, ToolbarMenu::Zoom)
        ));
        actions.clear();

        state.update(Message::MenuOpened(ToolbarMenu::Mode), &mut actions);
        state.update(Message::MenuClosed(ToolbarMenu::Zoom), &mut actions);
        assert_eq!(*state.open_menu, Some(ToolbarMenu::Mode));
        state.update(Message::MenuClosed(ToolbarMenu::Mode), &mut actions);
        assert_eq!(*state.open_menu, None);
    }

    #[test]
    fn editor_parameter_interactions_balance_gesture_actions() {
        let mut compare_segment_focused = false;
        let mut open_menu = None;
        let mut toolbar_anchors = HashMap::new();
        let mut parameters = vec![PluginParameter {
            id: 7,
            title: "Gain".to_owned(),
            units: "dB".to_owned(),
            step_count: 0,
            default_normalized: 0.5,
            normalized: 0.5,
            formatted: String::new(),
            flags: 0,
        }];
        let mut active_gestures = HashSet::new();
        let mut state = EditorInteractionState {
            preference: PluginEditorPreference::default(),
            active_mode: PluginEditorMode::Parameters,
            appearance: PluginEditorAppearance::default(),
            effective_scale: 1.0,
            logical_size: Size::new(640.0, 480.0),
            cursor: Cursor::Unavailable,
            compare_segment_focused: &mut compare_segment_focused,
            open_menu: &mut open_menu,
            toolbar_anchors: &mut toolbar_anchors,
            parameters: &mut parameters,
            active_gestures: &mut active_gestures,
        };
        let mut actions = Vec::new();

        state.update(Message::ParameterChanged(7, 0.75), &mut actions);
        assert_eq!(state.parameters[0].normalized, 0.75);
        assert!(matches!(
            actions.as_slice(),
            [
                EditorAction::Parameter {
                    parameter_id: 7,
                    normalized: 0.75,
                    gesture: ParameterGesture::Begin,
                },
                EditorAction::Parameter {
                    parameter_id: 7,
                    normalized: 0.75,
                    gesture: ParameterGesture::Perform,
                },
            ]
        ));
        actions.clear();

        state.update(Message::ParameterChanged(7, 0.25), &mut actions);
        assert!(matches!(
            actions.as_slice(),
            [EditorAction::Parameter {
                parameter_id: 7,
                normalized: 0.25,
                gesture: ParameterGesture::Perform,
            }]
        ));
        actions.clear();

        state.update(Message::ParameterReleased(7), &mut actions);
        assert!(matches!(
            actions.as_slice(),
            [EditorAction::Parameter {
                parameter_id: 7,
                normalized: 0.25,
                gesture: ParameterGesture::End,
            }]
        ));
        actions.clear();
        state.update(Message::ParameterReleased(7), &mut actions);
        assert!(actions.is_empty());

        state.update(Message::ParameterChanged(99, 0.5), &mut actions);
        actions.clear();
        state.update(Message::ParameterReleased(99), &mut actions);
        assert!(matches!(
            actions.as_slice(),
            [EditorAction::Parameter {
                parameter_id: 99,
                normalized: 0.0,
                gesture: ParameterGesture::End,
            }]
        ));
    }

    #[test]
    fn editor_view_builds_native_and_parameter_variants() {
        let mut native = editor_view_model(
            PluginEditorMode::Native,
            PluginEditorAppearance {
                theme: PluginEditorTheme::Light,
                locale: PluginEditorLocale::EnUs,
            },
            Vec::new(),
        );
        native.open_menu = Some(ToolbarMenu::Mode);
        native.warning = Some("Retryable warning".to_owned());
        drop(EditorWindow::view(&native));

        let parameters = vec![
            PluginParameter {
                id: 1,
                title: "Read only".to_owned(),
                units: "dB".to_owned(),
                step_count: 10,
                default_normalized: 0.5,
                normalized: 0.5,
                formatted: "-6.0 dB".to_owned(),
                flags: VST3_PARAMETER_FLAG_READ_ONLY,
            },
            PluginParameter {
                id: 2,
                title: "With units".to_owned(),
                units: "Hz".to_owned(),
                step_count: 0,
                default_normalized: 0.0,
                normalized: 0.25,
                formatted: String::new(),
                flags: 0,
            },
            PluginParameter {
                id: 3,
                title: "Percent".to_owned(),
                units: String::new(),
                step_count: 4,
                default_normalized: 0.0,
                normalized: 2.0,
                formatted: String::new(),
                flags: 0,
            },
        ];
        let mut parameter_model = editor_view_model(
            PluginEditorMode::Parameters,
            PluginEditorAppearance {
                theme: PluginEditorTheme::Dark,
                locale: PluginEditorLocale::ZhCmnHansCn,
            },
            parameters,
        );
        parameter_model.narrow_toolbar = true;
        parameter_model.toolbar_height = TOOLBAR_HEIGHT_NARROW as f32;
        parameter_model.compare_slot = CompareSlot::B;
        parameter_model.can_compare = false;
        parameter_model.can_paste = false;
        parameter_model.can_undo = false;
        parameter_model.can_redo = true;
        drop(EditorWindow::view(&parameter_model));

        parameter_model.parameters.clear();
        parameter_model.context.channel_color = "invalid".to_owned();
        drop(EditorWindow::view(&parameter_model));
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
