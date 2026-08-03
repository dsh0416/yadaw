#[cfg(test)]
mod tests {
    use super::*;
    use yadaw_dsp_runtime::protocol::LiveMixerChannel;

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
        #[cfg(target_os = "windows")]
        assert_eq!((geometry.frame_width, geometry.frame_height), (800, 400));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!((geometry.frame_width, geometry.frame_height), (400, 200));
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
            initial_toolbar_highlight(&options, &ToolbarMenuChoice::Zoom(225)),
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
            initial_toolbar_highlight(&options, &ToolbarMenuChoice::Zoom(200)),
            0
        );
        assert_eq!(
            initial_toolbar_highlight(&[], &ToolbarMenuChoice::Zoom(100)),
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
            ToolbarMenuContext {
                active_mode: PluginEditorMode::Parameters,
                zoom_percent: 225,
                appearance,
                effective_scale: 1.5,
                sidechain_buses: &[],
                sidechain_sources: &[],
                pending_sidechain: &None,
            },
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
            ToolbarMenuContext {
                active_mode: PluginEditorMode::Native,
                zoom_percent: 225,
                appearance,
                effective_scale: 2.0,
                sidechain_buses: &[],
                sidechain_sources: &[],
                pending_sidechain: &None,
            },
        );
        assert_eq!(zoom.selected, ToolbarMenuChoice::Zoom(225));
        assert!(zoom.options.iter().any(|option| {
            option.choice == ToolbarMenuChoice::Zoom(225) && option.label == "225%"
        }));
    }

    #[test]
    fn native_toolbar_popup_flattens_sidechain_routes_without_losing_typed_ids() {
        let buses = vec![SidechainBus {
            input_bus_index: 3,
            name: "Detector".to_owned(),
            source_channel_id: Some("audio-old".to_owned()),
        }];
        let sources = vec![
            SidechainSource {
                id: "audio-old".to_owned(),
                name: "Old Key".to_owned(),
                kind: SidechainSourceKind::Audio,
            },
            SidechainSource {
                id: "aux-new".to_owned(),
                name: "Drum Bus".to_owned(),
                kind: SidechainSourceKind::Aux,
            },
        ];
        let pending = Some(PendingSidechainRequest {
            request_id: 9,
            input_bus_index: 3,
            source_channel_id: Some("aux-new".to_owned()),
            displayed_source_channel_id: Some("audio-old".to_owned()),
        });

        let request = toolbar_menu_request_for(
            ToolbarMenu::Sidechain,
            Rectangle::default(),
            ToolbarMenuContext {
                active_mode: PluginEditorMode::Native,
                zoom_percent: 100,
                appearance: PluginEditorAppearance::default(),
                effective_scale: 1.0,
                sidechain_buses: &buses,
                sidechain_sources: &sources,
                pending_sidechain: &pending,
            },
        );

        assert_eq!(request.menu, ToolbarMenu::Sidechain);
        assert_eq!(request.options.len(), 3);
        assert_eq!(request.options[0].label, "Detector · None");
        assert!(request.options.iter().any(|option| {
            option.label == "Detector · Aux · Drum Bus"
                && option.choice
                    == ToolbarMenuChoice::SidechainRoute {
                        input_bus_index: 3,
                        source_channel_id: Some("aux-new".to_owned()),
                    }
        }));
        assert_eq!(
            request.selected,
            ToolbarMenuChoice::SidechainRoute {
                input_bus_index: 3,
                source_channel_id: Some("audio-old".to_owned()),
            }
        );
        assert!(matches!(
            toolbar_choice_action(
                PluginEditorPreference::default(),
                ToolbarMenuChoice::SidechainRoute {
                    input_bus_index: 3,
                    source_channel_id: Some("aux-new".to_owned()),
                }
            ),
            Some(EditorAction::SidechainRoute {
                input_bus_index: 3,
                source_channel_id: Some(source),
            }) if source == "aux-new"
        ));
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
            sidechain_buses: Vec::new(),
            sidechain_sources: Vec::new(),
            sidechain_menu: None,
            pending_sidechain: None,
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
        let sidechain_buses = Vec::new();
        let sidechain_sources = Vec::new();
        let mut sidechain_menu = None;
        let pending_sidechain = None;
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
            sidechain_buses: &sidechain_buses,
            sidechain_sources: &sidechain_sources,
            sidechain_menu: &mut sidechain_menu,
            pending_sidechain: &pending_sidechain,
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
                if request.anchor
                    == fallback_toolbar_anchor(state.logical_size, ToolbarMenu::Zoom, false)
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
        let sidechain_buses = Vec::new();
        let sidechain_sources = Vec::new();
        let mut sidechain_menu = None;
        let pending_sidechain = None;
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
            sidechain_buses: &sidechain_buses,
            sidechain_sources: &sidechain_sources,
            sidechain_menu: &mut sidechain_menu,
            pending_sidechain: &pending_sidechain,
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

    fn view_model(
        active_mode: PluginEditorMode,
        parameters: Vec<PluginParameter>,
    ) -> EditorViewModel {
        EditorViewModel {
            context: PluginEditorContext {
                channel_name: "Lead".to_owned(),
                channel_color: "#58c6c2".to_owned(),
                plugin_name: "Fixture".to_owned(),
                appearance: PluginEditorAppearance {
                    theme: PluginEditorTheme::Dark,
                    locale: PluginEditorLocale::EnUs,
                },
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
            can_redo: true,
            sidechain_buses: Vec::new(),
            sidechain_sources: Vec::new(),
            sidechain_menu: None,
            pending_sidechain: None,
        }
    }

    #[test]
    fn editor_view_builds_native_and_empty_parameter_layouts() {
        let native = view_model(PluginEditorMode::Native, Vec::new());
        let _native_element = EditorWindow::view(&native);

        let mut parameters = view_model(PluginEditorMode::Parameters, Vec::new());
        parameters.narrow_toolbar = true;
        parameters.toolbar_height = TOOLBAR_HEIGHT_NARROW as f32;
        parameters.warning = Some("Fixture warning".to_owned());
        parameters.context.channel_color = "invalid".to_owned();
        parameters.context.appearance.theme = PluginEditorTheme::Light;
        parameters.context.appearance.locale = PluginEditorLocale::ZhCmnHansCn;
        let _parameter_element = EditorWindow::view(&parameters);
    }

    #[test]
    fn editor_view_builds_parameter_controls_and_all_sidechain_columns() {
        let mut model = view_model(
            PluginEditorMode::Parameters,
            vec![
                PluginParameter {
                    id: 1,
                    title: "Input".to_owned(),
                    units: "dB".to_owned(),
                    step_count: 0,
                    default_normalized: 0.5,
                    normalized: 0.75,
                    formatted: "-6.0 dB".to_owned(),
                    flags: 0,
                },
                PluginParameter {
                    id: 2,
                    title: "Meter".to_owned(),
                    units: String::new(),
                    step_count: 10,
                    default_normalized: 0.0,
                    normalized: 0.25,
                    formatted: String::new(),
                    flags: VST3_PARAMETER_FLAG_READ_ONLY,
                },
            ],
        );
        model.compare_slot = CompareSlot::B;
        model.sidechain_buses = vec![SidechainBus {
            input_bus_index: 1,
            name: "Side-chain".to_owned(),
            source_channel_id: Some("audio-1".to_owned()),
        }];
        model.sidechain_sources = vec![
            SidechainSource {
                id: "audio-1".to_owned(),
                name: "Audio 1".to_owned(),
                kind: SidechainSourceKind::Audio,
            },
            SidechainSource {
                id: "instrument-1".to_owned(),
                name: "Instrument 1".to_owned(),
                kind: SidechainSourceKind::Instrument,
            },
            SidechainSource {
                id: "aux-1".to_owned(),
                name: "Aux 1".to_owned(),
                kind: SidechainSourceKind::Aux,
            },
        ];
        model.sidechain_menu = Some(SidechainMenuState {
            bus: 0,
            group: Some(SidechainSourceKind::Audio),
            level: 2,
            focused: 0,
        });
        model.pending_sidechain = Some(PendingSidechainRequest {
            request_id: 7,
            input_bus_index: 1,
            source_channel_id: Some("aux-1".to_owned()),
            displayed_source_channel_id: Some("audio-1".to_owned()),
        });

        let _element = EditorWindow::view(&model);
    }

    fn sidechain_key_fixture() -> (Vec<SidechainBus>, Vec<SidechainSource>) {
        (
            vec![
                SidechainBus {
                    input_bus_index: 1,
                    name: "Side-chain A".to_owned(),
                    source_channel_id: None,
                },
                SidechainBus {
                    input_bus_index: 7,
                    name: "Side-chain B".to_owned(),
                    source_channel_id: None,
                },
            ],
            vec![
                SidechainSource {
                    id: "audio-1".to_owned(),
                    name: "Audio 1".to_owned(),
                    kind: SidechainSourceKind::Audio,
                },
                SidechainSource {
                    id: "audio-2".to_owned(),
                    name: "Audio 2".to_owned(),
                    kind: SidechainSourceKind::Audio,
                },
                SidechainSource {
                    id: "instrument-1".to_owned(),
                    name: "Instrument 1".to_owned(),
                    kind: SidechainSourceKind::Instrument,
                },
                SidechainSource {
                    id: "aux-1".to_owned(),
                    name: "Aux 1".to_owned(),
                    kind: SidechainSourceKind::Aux,
                },
            ],
        )
    }

    #[test]
    fn sidechain_keyboard_navigates_buses_groups_and_sources() {
        let (buses, sources) = sidechain_key_fixture();
        let mut menu = Some(SidechainMenuState {
            bus: 0,
            group: None,
            level: 0,
            focused: 0,
        });

        assert!(
            sidechain_key_action(
                &mut menu,
                &buses,
                &sources,
                &Key::Named(NamedKey::ArrowDown),
            )
            .0
        );
        assert_eq!(menu.map(|state| state.focused), Some(1));
        sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::Enter),
        );
        assert_eq!(menu.map(|state| (state.bus, state.level)), Some((1, 1)));
        sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::ArrowDown),
        );
        sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::Enter),
        );
        assert_eq!(
            menu.map(|state| (state.group, state.level, state.focused)),
            Some((Some(SidechainSourceKind::Audio), 2, 0))
        );
        sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::ArrowDown),
        );
        let (_, close, action) = sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::Enter),
        );
        assert!(!close);
        assert!(matches!(
            action,
            Some(EditorAction::SidechainRoute {
                input_bus_index: 7,
                source_channel_id: Some(source),
            }) if source == "audio-2"
        ));

        sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::ArrowLeft),
        );
        assert_eq!(menu.map(|state| (state.level, state.focused)), Some((1, 1)));
        sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::ArrowLeft),
        );
        assert_eq!(menu.map(|state| (state.level, state.focused)), Some((0, 1)));
        sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::ArrowUp),
        );
        assert_eq!(menu.map(|state| state.focused), Some(0));
        let (handled, close, action) = sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::Escape),
        );
        assert_eq!((handled, close), (true, true));
        assert!(action.is_none());
    }

    #[test]
    fn sidechain_keyboard_handles_none_empty_and_unhandled_paths() {
        let (buses, sources) = sidechain_key_fixture();
        let mut closed = None;
        let (handled, close, action) = sidechain_key_action(
            &mut closed,
            &buses,
            &sources,
            &Key::Character("x".into()),
        );
        assert_eq!((handled, close), (false, false));
        assert!(action.is_none());

        let mut menu = Some(SidechainMenuState {
            bus: 0,
            group: None,
            level: 1,
            focused: 0,
        });
        let (handled, close, action) = sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::ArrowRight),
        );
        assert_eq!((handled, close), (true, false));
        assert!(action.is_none());
        let (_, _, action) = sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::Enter),
        );
        assert!(matches!(
            action,
            Some(EditorAction::SidechainRoute {
                input_bus_index: 1,
                source_channel_id: None,
            })
        ));

        menu = Some(SidechainMenuState {
            bus: 0,
            group: None,
            level: 2,
            focused: 0,
        });
        let (handled, close, action) = sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::Enter),
        );
        assert_eq!((handled, close), (true, false));
        assert!(action.is_none());
        menu = Some(SidechainMenuState {
            bus: 0,
            group: Some(SidechainSourceKind::Audio),
            level: 2,
            focused: 99,
        });
        let (handled, close, action) = sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Named(NamedKey::Enter),
        );
        assert_eq!((handled, close), (true, false));
        assert!(action.is_none());
        let (handled, close, action) = sidechain_key_action(
            &mut menu,
            &buses,
            &sources,
            &Key::Character("x".into()),
        );
        assert_eq!((handled, close), (false, false));
        assert!(action.is_none());
    }

    #[test]
    fn sidechain_keyboard_restores_each_group_focus() {
        let (buses, sources) = sidechain_key_fixture();
        for (focused, group) in [
            (2, SidechainSourceKind::Instrument),
            (3, SidechainSourceKind::Aux),
        ] {
            let mut menu = Some(SidechainMenuState {
                bus: 0,
                group: None,
                level: 1,
                focused,
            });
            sidechain_key_action(
                &mut menu,
                &buses,
                &sources,
                &Key::Named(NamedKey::Enter),
            );
            assert_eq!(menu.map(|state| state.group), Some(Some(group)));
            sidechain_key_action(
                &mut menu,
                &buses,
                &sources,
                &Key::Named(NamedKey::ArrowLeft),
            );
            assert_eq!(menu.map(|state| state.focused), Some(focused));
        }

        let mut empty_group = Some(SidechainMenuState {
            bus: 0,
            group: None,
            level: 1,
            focused: 1,
        });
        sidechain_key_action(
            &mut empty_group,
            &buses,
            &[],
            &Key::Named(NamedKey::Enter),
        );
        assert_eq!(empty_group.map(|state| state.level), Some(1));
        assert_eq!(source_count_for_group(&sources, None), 0);
    }

    #[test]
    fn sidechain_menu_messages_preserve_pending_request_serialization() {
        let mut menu = None;
        open_sidechain_menu(&mut menu);
        assert_eq!(
            menu.map(|state| (state.bus, state.group, state.level, state.focused)),
            Some((0, None, 0, 0))
        );

        select_sidechain_bus(&mut menu, 3);
        assert_eq!(
            menu.map(|state| (state.bus, state.group, state.level, state.focused)),
            Some((3, None, 1, 0))
        );
        select_sidechain_group(&mut menu, SidechainSourceKind::Aux);
        assert_eq!(
            menu.map(|state| (state.group, state.level, state.focused)),
            Some((Some(SidechainSourceKind::Aux), 2, 0))
        );

        let mut closed = None;
        select_sidechain_group(&mut closed, SidechainSourceKind::Audio);
        assert!(closed.is_none());
        assert!(sidechain_route_action(true, 7, Some("audio-1".to_owned())).is_none());
        assert!(matches!(
            sidechain_route_action(false, 7, Some("audio-1".to_owned())),
            Some(EditorAction::SidechainRoute {
                input_bus_index: 7,
                source_channel_id: Some(source),
            }) if source == "audio-1"
        ));
    }

    fn routing_channel(id: &str, output_channel_id: Option<&str>) -> LiveMixerChannel {
        LiveMixerChannel {
            id: id.to_owned(),
            name: id.to_owned(),
            color: String::new(),
            kind: "audio".to_owned(),
            system_role: None,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output_channel_id: output_channel_id.map(str::to_owned),
            output_bus: None,
            record_armed: false,
            input_monitoring: false,
            midi_input_port_id: None,
            midi_input_port_name: None,
            midi_input_channel: None,
            input_source: None,
            input_channels: Vec::new(),
            hardware_output_channels: Vec::new(),
        }
    }

    fn routing_graph() -> LiveMixerGraph {
        LiveMixerGraph {
            sample_rate: 48_000,
            channels: vec![
                routing_channel("target", None),
                routing_channel("source", None),
                routing_channel("middle", None),
                routing_channel("isolated", None),
            ],
            sends: Vec::new(),
            clips: Vec::new(),
            plugins: Vec::new(),
            midi_clips: Vec::new(),
            tempo_events: Vec::new(),
            time_signature_events: Vec::new(),
        }
    }

    #[test]
    fn sidechain_cycle_detection_follows_outputs_sends_and_existing_sidechains() {
        use yadaw_dsp_runtime::protocol::{
            LiveMixerSend, LiveMixerSendTap, LivePluginAuxInputBus, LivePluginInstance,
            PluginAudioMode,
        };

        let graph = routing_graph();
        assert!(sidechain_route_would_cycle(&graph, "target", "target"));
        assert!(!sidechain_route_would_cycle(
            &graph, "target", "isolated"
        ));

        let mut output_graph = graph.clone();
        output_graph.channels[0].output_channel_id = Some("middle".to_owned());
        output_graph.channels[2].output_channel_id = Some("source".to_owned());
        assert!(sidechain_route_would_cycle(
            &output_graph,
            "target",
            "source"
        ));

        let mut send_graph = graph.clone();
        send_graph.sends.push(LiveMixerSend {
            id: "send".to_owned(),
            source_channel_id: "target".to_owned(),
            target_channel_id: Some("source".to_owned()),
            target_bus: None,
            enabled: true,
            tap: LiveMixerSendTap::PostPan,
            level_db: 0.0,
        });
        assert!(sidechain_route_would_cycle(
            &send_graph,
            "target",
            "source"
        ));
        send_graph.sends[0].enabled = false;
        assert!(!sidechain_route_would_cycle(
            &send_graph,
            "target",
            "source"
        ));

        let mut plugin_graph = graph;
        plugin_graph.plugins.push(LivePluginInstance {
            instance_id: "fixture".to_owned(),
            channel_id: "source".to_owned(),
            role: "effect".to_owned(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: vec![LivePluginAuxInputBus {
                input_bus_index: 1,
                name: "Side-chain".to_owned(),
                channels: 2,
                source_channel_id: Some("target".to_owned()),
            }],
            latency_samples: 0,
            tail_samples: Some(0),
        });
        assert!(sidechain_route_would_cycle(
            &plugin_graph,
            "target",
            "source"
        ));
    }

    #[test]
    fn sidechain_cycle_detection_terminates_on_an_unrelated_loop() {
        let mut graph = routing_graph();
        graph.channels[0].output_channel_id = Some("middle".to_owned());
        graph.channels[2].output_channel_id = Some("target".to_owned());

        assert!(!sidechain_route_would_cycle(
            &graph, "target", "isolated"
        ));
    }

    #[test]
    fn sidechain_view_filters_channel_kinds_system_channels_self_and_cycles() {
        use yadaw_dsp_runtime::protocol::{
            LiveMixerSystemRole, LivePluginAuxInputBus, LivePluginInstance, PluginAudioMode,
        };

        let mut graph = routing_graph();
        graph.channels[0].output_channel_id = Some("cycle".to_owned());
        graph.channels[1].id = "audio".to_owned();
        graph.channels[1].name = "Audio".to_owned();
        graph.channels[2].id = "instrument".to_owned();
        graph.channels[2].name = "Instrument".to_owned();
        graph.channels[2].kind = "instrument".to_owned();
        graph.channels[3].id = "aux".to_owned();
        graph.channels[3].name = "Aux".to_owned();
        graph.channels[3].kind = "aux".to_owned();
        let mut system = routing_channel("metronome", None);
        system.system_role = Some(LiveMixerSystemRole::Metronome);
        let mut unsupported = routing_channel("midi", None);
        unsupported.kind = "midi".to_owned();
        graph.channels.extend([
            system,
            unsupported,
            routing_channel("cycle", None),
        ]);
        graph.plugins.push(LivePluginInstance {
            instance_id: "fixture".to_owned(),
            channel_id: "target".to_owned(),
            role: "effect".to_owned(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: vec![LivePluginAuxInputBus {
                input_bus_index: 3,
                name: "Detector".to_owned(),
                channels: 1,
                source_channel_id: Some("audio".to_owned()),
            }],
            latency_samples: 0,
            tail_samples: Some(0),
        });

        assert!(sidechain_view_for_graph(None, "fixture").is_none());
        assert!(sidechain_view_for_graph(Some(&graph), "missing").is_none());
        let (buses, sources) = sidechain_view_for_graph(Some(&graph), "fixture").unwrap();
        assert_eq!(buses.len(), 1);
        assert_eq!(buses[0].input_bus_index, 3);
        assert_eq!(buses[0].name, "Detector");
        assert_eq!(buses[0].source_channel_id.as_deref(), Some("audio"));
        assert_eq!(
            sources
                .iter()
                .map(|source| (source.id.as_str(), source.kind))
                .collect::<Vec<_>>(),
            vec![
                ("audio", SidechainSourceKind::Audio),
                ("instrument", SidechainSourceKind::Instrument),
                ("aux", SidechainSourceKind::Aux),
            ]
        );
    }

    #[test]
    fn sidechain_pending_state_keeps_displayed_value_until_matching_resolution() {
        let buses = vec![SidechainBus {
            input_bus_index: 3,
            name: "Detector".to_owned(),
            source_channel_id: Some("old-source".to_owned()),
        }];
        let mut pending = None;
        assert!(begin_sidechain_pending(
            &mut pending,
            &buses,
            11,
            3,
            Some("new-source".to_owned()),
        ));
        let request = pending.as_ref().unwrap();
        assert_eq!(request.request_id, 11);
        assert_eq!(request.input_bus_index, 3);
        assert_eq!(request.source_channel_id.as_deref(), Some("new-source"));
        assert_eq!(
            request.displayed_source_channel_id.as_deref(),
            Some("old-source")
        );
        assert!(!begin_sidechain_pending(
            &mut pending,
            &buses,
            12,
            3,
            None,
        ));

        let mut warning = None;
        assert!(!resolve_sidechain_pending(
            &mut pending,
            &mut warning,
            12,
            true,
            None,
        ));
        assert!(pending.is_some());
        assert!(resolve_sidechain_pending(
            &mut pending,
            &mut warning,
            11,
            true,
            Some("Audio deployment is degraded".to_owned()),
        ));
        assert!(pending.is_none());
        assert_eq!(warning.as_deref(), Some("Audio deployment is degraded"));
    }

    #[test]
    fn sidechain_pending_rejection_uses_host_warning_or_fallback() {
        let mut warning = Some("old warning".to_owned());
        for (request_id, supplied, expected) in [
            (1, Some("database rejected"), "database rejected"),
            (2, None, "Side-chain routing could not be committed."),
        ] {
            let mut pending = None;
            assert!(begin_sidechain_pending(
                &mut pending,
                &[],
                request_id,
                9,
                None,
            ));
            assert!(resolve_sidechain_pending(
                &mut pending,
                &mut warning,
                request_id,
                false,
                supplied.map(str::to_owned),
            ));
            assert_eq!(warning.as_deref(), Some(expected));
        }

        let mut pending = None;
        assert!(begin_sidechain_pending(&mut pending, &[], 3, 9, None));
        assert!(resolve_sidechain_pending(
            &mut pending,
            &mut warning,
            3,
            true,
            None,
        ));
        assert_eq!(
            warning.as_deref(),
            Some("Side-chain routing could not be committed.")
        );
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
