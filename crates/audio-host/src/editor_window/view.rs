const VST3_PARAMETER_FLAG_READ_ONLY: u32 = 1 << 1;

struct EditorInteractionState<'a> {
    preference: PluginEditorPreference,
    active_mode: PluginEditorMode,
    appearance: PluginEditorAppearance,
    effective_scale: f64,
    logical_size: Size,
    cursor: Cursor,
    compare_segment_focused: &'a mut bool,
    open_menu: &'a mut Option<ToolbarMenu>,
    toolbar_anchors: &'a mut HashMap<ToolbarMenu, Rectangle>,
    parameters: &'a mut [PluginParameter],
    active_gestures: &'a mut HashSet<u32>,
    sidechain_buses: &'a [SidechainBus],
    sidechain_sources: &'a [SidechainSource],
    sidechain_menu: &'a mut Option<SidechainMenuState>,
    pending_sidechain: &'a Option<PendingSidechainRequest>,
}

impl EditorInteractionState<'_> {
    fn update(&mut self, message: Message, actions: &mut Vec<EditorAction>) {
        match message {
            Message::UseMode(mode) => {
                *self.compare_segment_focused = false;
                *self.open_menu = None;
                if mode != self.preference.mode {
                    actions.push(EditorAction::PreferenceChanged(PluginEditorPreference {
                        mode,
                        zoom_percent: self.preference.zoom_percent,
                    }));
                }
            }
            Message::UseCompareSlot(slot) => {
                *self.compare_segment_focused = true;
                actions.push(EditorAction::UseCompareSlot(slot));
            }
            Message::CopyState => actions.push(EditorAction::CopyState),
            Message::PasteState => actions.push(EditorAction::PasteState),
            Message::Undo => actions.push(EditorAction::Undo),
            Message::Redo => actions.push(EditorAction::Redo),
            Message::ZoomPreset(zoom_percent) => {
                *self.compare_segment_focused = false;
                *self.open_menu = None;
                actions.push(EditorAction::PreferenceChanged(PluginEditorPreference {
                    mode: self.preference.mode,
                    zoom_percent,
                }));
            }
            Message::ToolbarTriggerHovered(menu, local_position) => {
                if let Cursor::Available(cursor) = self.cursor {
                    let width = match menu {
                        ToolbarMenu::Mode => 112.0,
                        ToolbarMenu::Zoom => 72.0,
                        ToolbarMenu::Sidechain => 112.0,
                    };
                    self.toolbar_anchors.insert(
                        menu,
                        Rectangle::new(
                            Point::new(
                                cursor.x - local_position.x,
                                cursor.y - local_position.y,
                            ),
                            Size::new(width, heron_iced_ui::CONTROL_COMPACT),
                        ),
                    );
                }
            }
            Message::OpenToolbarMenu(menu) => {
                *self.compare_segment_focused = false;
                *self.open_menu = Some(menu);
                let anchor = self.toolbar_anchors.get(&menu).copied().unwrap_or_else(|| {
                    fallback_toolbar_anchor(
                        self.logical_size,
                        menu,
                        !self.sidechain_buses.is_empty(),
                    )
                });
                actions.push(EditorAction::OpenToolbarMenu(toolbar_menu_request_for(
                    menu,
                    anchor,
                    ToolbarMenuContext {
                        active_mode: self.active_mode,
                        zoom_percent: self.preference.zoom_percent,
                        appearance: self.appearance,
                        effective_scale: self.effective_scale,
                        sidechain_buses: self.sidechain_buses,
                        sidechain_sources: self.sidechain_sources,
                        pending_sidechain: self.pending_sidechain,
                    },
                )));
            }
            Message::MenuOpened(menu) => {
                *self.compare_segment_focused = false;
                *self.open_menu = Some(menu);
                if menu == ToolbarMenu::Sidechain {
                    open_sidechain_menu(self.sidechain_menu);
                }
            }
            Message::MenuClosed(menu) => {
                if *self.open_menu == Some(menu) {
                    *self.open_menu = None;
                    if menu == ToolbarMenu::Sidechain {
                        *self.sidechain_menu = None;
                    }
                }
            }
            Message::SidechainBus(bus) => select_sidechain_bus(self.sidechain_menu, bus),
            Message::SidechainGroup(group) => {
                select_sidechain_group(self.sidechain_menu, group);
            }
            Message::SidechainRoute(input_bus_index, source_channel_id) => {
                if let Some(action) = sidechain_route_action(
                    self.pending_sidechain.is_some(),
                    input_bus_index,
                    source_channel_id,
                ) {
                    actions.push(action);
                }
            }
            Message::ParameterChanged(parameter_id, normalized) => {
                if let Some(parameter) = self
                    .parameters
                    .iter_mut()
                    .find(|parameter| parameter.id == parameter_id)
                {
                    parameter.normalized = normalized;
                }
                if self.active_gestures.insert(parameter_id) {
                    actions.push(EditorAction::Parameter {
                        parameter_id,
                        normalized,
                        gesture: ParameterGesture::Begin,
                    });
                }
                actions.push(EditorAction::Parameter {
                    parameter_id,
                    normalized,
                    gesture: ParameterGesture::Perform,
                });
            }
            Message::ParameterReleased(parameter_id) => {
                if self.active_gestures.remove(&parameter_id) {
                    let normalized = self
                        .parameters
                        .iter()
                        .find(|parameter| parameter.id == parameter_id)
                        .map_or(0.0, |parameter| parameter.normalized);
                    actions.push(EditorAction::Parameter {
                        parameter_id,
                        normalized,
                        gesture: ParameterGesture::End,
                    });
                }
            }
        }
    }
}

impl EditorWindow {
    fn handle_sidechain_key(&mut self, key: &Key) -> (bool, Option<EditorAction>) {
        let (handled, close, action) = sidechain_key_action(
            &mut self.sidechain_menu,
            &self.sidechain_buses,
            &self.sidechain_sources,
            key,
        );
        if close {
            self.close_toolbar_menu();
        }
        (handled, action)
    }

    fn update(&mut self, message: Message, actions: &mut Vec<EditorAction>) {
        let effective_scale = self.effective_scale();
        let logical_size = self.viewport.logical_size();
        EditorInteractionState {
            preference: self.preference,
            active_mode: self.active_mode,
            appearance: self.context.appearance,
            effective_scale,
            logical_size,
            cursor: self.cursor,
            compare_segment_focused: &mut self.compare_segment_focused,
            open_menu: &mut self.open_menu,
            toolbar_anchors: &mut self.toolbar_anchors,
            parameters: &mut self.parameters,
            active_gestures: &mut self.active_gestures,
            sidechain_buses: &self.sidechain_buses,
            sidechain_sources: &self.sidechain_sources,
            sidechain_menu: &mut self.sidechain_menu,
            pending_sidechain: &self.pending_sidechain,
        }
        .update(message, actions);
    }

    fn view_model(&self) -> EditorViewModel {
        let logical_width = self.viewport.logical_size().width;
        EditorViewModel {
            context: self.context.clone(),
            zoom_percent: self.preference.zoom_percent,
            toolbar_height: editor_toolbar_height(logical_width) as f32,
            narrow_toolbar: is_narrow_toolbar(logical_width),
            active_mode: self.active_mode,
            open_menu: self.open_menu,
            warning: self
                .warning
                .clone()
                .or_else(|| self.native_scale_warning.clone()),
            parameters: if self.active_mode == PluginEditorMode::Parameters {
                self.parameters.clone()
            } else {
                Vec::new()
            },
            compare_slot: self.compare_slot,
            can_compare: self.compare_slots.is_some(),
            can_paste: self.can_paste,
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            sidechain_buses: self.sidechain_buses.clone(),
            sidechain_sources: self.sidechain_sources.clone(),
            sidechain_menu: self.sidechain_menu,
            pending_sidechain: self.pending_sidechain.clone(),
        }
    }

    fn view(model: &EditorViewModel) -> EditorElement<'_> {
        let appearance = editor_appearance(model.context.appearance.theme);
        let colors = appearance.palette();
        let strings = EditorStrings::for_locale(model.context.appearance.locale);
        let mode_options = [
            EditorModeOption {
                mode: PluginEditorMode::Native,
                label: strings.editor,
            },
            EditorModeOption {
                mode: PluginEditorMode::Parameters,
                label: strings.parameters,
            },
        ];
        let selected_mode = mode_options
            .iter()
            .copied()
            .find(|option| option.mode == model.active_mode);
        let mode: EditorElement<'_> = if model.active_mode == PluginEditorMode::Native {
            native_select_trigger(
                selected_mode
                    .map_or(strings.editor, |option| option.label)
                    .to_owned(),
                ToolbarMenu::Mode,
                112.0,
                model.open_menu == Some(ToolbarMenu::Mode),
                true,
                appearance,
            )
        } else {
            pick_list(mode_options, selected_mode, |option| Message::UseMode(option.mode))
                .on_open(Message::MenuOpened(ToolbarMenu::Mode))
                .on_close(Message::MenuClosed(ToolbarMenu::Mode))
                .style(heron_iced_ui::select(appearance))
                .text_size(type_size::CONTROL)
                .padding([2, 6])
                .width(112)
                .into()
        };
        let zoom_options = zoom_options(model.zoom_percent);
        let zoom_label = ZoomOption(model.zoom_percent).to_string();
        let zoom: EditorElement<'_> = if model.active_mode == PluginEditorMode::Native {
            native_select_trigger(
                zoom_label,
                ToolbarMenu::Zoom,
                72.0,
                model.open_menu == Some(ToolbarMenu::Zoom),
                true,
                appearance,
            )
        } else {
            pick_list(
                zoom_options,
                Some(ZoomOption(model.zoom_percent)),
                |option| Message::ZoomPreset(option.0),
            )
            .on_open(Message::MenuOpened(ToolbarMenu::Zoom))
            .on_close(Message::MenuClosed(ToolbarMenu::Zoom))
            .style(heron_iced_ui::select(appearance))
            .text_size(type_size::CONTROL)
            .padding([2, 6])
            .width(72)
            .into()
        };
        let sidechain_label = if model.pending_sidechain.is_some() {
            strings.pending
        } else {
            strings.sidechain
        };
        let sidechain: EditorElement<'_> = if model.active_mode == PluginEditorMode::Native {
            native_select_trigger(
                sidechain_label.to_owned(),
                ToolbarMenu::Sidechain,
                112.0,
                model.open_menu == Some(ToolbarMenu::Sidechain),
                model.pending_sidechain.is_none(),
                appearance,
            )
        } else {
            compact_button(
                sidechain_label,
                Message::MenuOpened(ToolbarMenu::Sidechain),
                model.pending_sidechain.is_none(),
                appearance,
            )
            .into()
        };

        let signal_color = parse_signal_color(&model.context.channel_color).unwrap_or(colors.action);
        let signal_rail = container(space::vertical())
            .width(Length::Fixed(heron_iced_ui::SIGNAL_RAIL_WIDTH))
            .height(Length::Fill)
            .style(move |_| container::Style {
                background: Some(signal_color.into()),
                border: Border {
                    radius: 2.0.into(),
                    ..Border::default()
                },
                ..container::Style::default()
            });

        let title = Row::new()
            .height(Length::Fixed(20.0))
            .spacing(ui_space::SM)
            .align_y(iced_core::alignment::Vertical::Bottom)
            .push(
                text(&model.context.channel_name)
                    .size(type_size::PANEL_TITLE)
                    .line_height(iced_core::Pixels(18.0))
                    .color(colors.text),
            )
            .push(
                text(&model.context.plugin_name)
                    .size(type_size::CAPTION)
                    .line_height(iced_core::Pixels(18.0))
                    .color(colors.text_muted),
            );
        let mut title_row = Row::new()
            .height(Length::Fixed(24.0))
            .spacing(ui_space::SM)
            .align_y(iced_core::alignment::Vertical::Center)
            .push(signal_rail)
            .push(title);
        if let Some(warning) = &model.warning {
            title_row = title_row
                .push(space::horizontal())
                .push(text(warning).size(type_size::CAPTION).color(colors.warning));
        }

        let compare_a = compare_segment_button(
            "A",
            Message::UseCompareSlot(CompareSlot::A),
            model.can_compare,
            model.compare_slot == CompareSlot::A,
            appearance,
        );
        let compare_b = compare_segment_button(
            "B",
            Message::UseCompareSlot(CompareSlot::B),
            model.can_compare,
            model.compare_slot == CompareSlot::B,
            appearance,
        );
        let copy = compact_button(
            strings.copy,
            Message::CopyState,
            true,
            appearance,
        );
        let paste = compact_button(
            strings.paste,
            Message::PasteState,
            model.can_paste,
            appearance,
        );
        let undo = compact_button(
            strings.undo,
            Message::Undo,
            model.can_undo,
            appearance,
        );
        let redo = compact_button(
            strings.redo,
            Message::Redo,
            model.can_redo,
            appearance,
        );
        let compare_group = container(
            Row::new()
                .height(Length::Fill)
                .push(compare_a)
                .push(compare_b),
        )
            .height(Length::Fixed(heron_iced_ui::CONTROL_COMPACT))
            .padding(1)
            .style(heron_iced_ui::segmented_group(
                appearance,
                model.can_compare,
            ));
        let action_row = Row::new()
            .height(Length::Fixed(24.0))
            .spacing(ui_space::XS)
            .align_y(iced_core::alignment::Vertical::Center)
            .push(compare_group)
            .push(space::horizontal().width(Length::Fixed(ui_space::XS)))
            .push(copy)
            .push(paste)
            .push(undo)
            .push(redo);
        let settings_row = Row::new()
            .height(Length::Fixed(24.0))
            .spacing(ui_space::XS)
            .align_y(iced_core::alignment::Vertical::Center)
            .push(mode)
            .push(space::horizontal().width(Length::Fixed(ui_space::XS)))
            .push(zoom);
        let settings_row = if model.sidechain_buses.is_empty() {
            settings_row
        } else {
            settings_row
                .push(space::horizontal().width(Length::Fixed(ui_space::XS)))
                .push(sidechain)
        };

        let command_section = if model.narrow_toolbar {
            Column::new().spacing(ui_space::XS).push(action_row).push(
                Row::new()
                    .width(Length::Fill)
                    .push(space::horizontal())
                    .push(settings_row),
            )
        } else {
            Column::new().push(
                Row::new()
                    .height(Length::Fixed(24.0))
                    .align_y(iced_core::alignment::Vertical::Center)
                    .push(action_row)
                    .push(space::horizontal())
                    .push(settings_row),
            )
        };

        let toolbar = container(
            Column::new()
                .spacing(ui_space::XS)
                .push(title_row)
                .push(command_section),
        )
        .padding([6, ui_space::SM as u16])
        .height(Length::Fixed(model.toolbar_height))
        .width(Length::Fill)
        .style(heron_iced_ui::chrome(appearance));

        let mut content = Column::new().push(toolbar);
        if model.active_mode == PluginEditorMode::Parameters {
            let parameter_list = if model.parameters.is_empty() {
                Column::new().push(
                    container(
                        text(strings.empty_parameters)
                            .size(type_size::BODY_COMPACT)
                            .color(colors.text_muted),
                    )
                    .padding(ui_space::XL)
                    .width(Length::Fill),
                )
            } else {
                model.parameters.iter().fold(
                    Column::new()
                        .spacing(ui_space::SM)
                        .padding([ui_space::MD, ui_space::LG]),
                    |column, parameter| {
                        let step = parameter_step(parameter.step_count);
                        let id = parameter.id;
                        let value = parameter.normalized.clamp(0.0, 1.0);
                        let value_text = if !parameter.formatted.is_empty() {
                            parameter.formatted.clone()
                        } else if parameter.units.is_empty() {
                            format!("{:.1}%", value * 100.0)
                        } else {
                            format!("{:.1}%  {}", value * 100.0, parameter.units)
                        };
                        let control: Element<'_, Message, Theme, Renderer> =
                            if parameter.flags & VST3_PARAMETER_FLAG_READ_ONLY != 0 {
                                container(
                                    text(value_text.clone())
                                        .size(type_size::CONTROL)
                                        .color(colors.text_muted),
                                )
                                .width(Length::Fill)
                                .into()
                            } else {
                                slider(0.0..=1.0, value, move |normalized| {
                                    Message::ParameterChanged(id, normalized)
                                })
                                .step(step)
                                .on_release(Message::ParameterReleased(id))
                                .style(heron_iced_ui::parameter_slider(appearance))
                                .into()
                            };
                        column.push(
                            container(
                                Column::new()
                                    .spacing(ui_space::SM)
                                    .push(
                                        Row::new()
                                            .push(
                                                text(&parameter.title)
                                                    .size(type_size::BODY_COMPACT),
                                            )
                                            .push(space::horizontal())
                                            .push(
                                                text(value_text)
                                                    .size(type_size::CONTROL)
                                                    .color(colors.text_muted),
                                            ),
                                    )
                                    .push(control),
                            )
                            .padding(ui_space::MD)
                            .width(Length::Fill)
                            .style(heron_iced_ui::surface(appearance, false)),
                        )
                    },
                )
            };
            content = content.push(
                scrollable(parameter_list)
                    .width(Length::Fill)
                    .height(Length::Fill),
            );
        } else {
            content = content.push(container(text("")).width(Length::Fill).height(Length::Fill));
        }
        let content: EditorElement<'_> = container(content)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(heron_iced_ui::canvas(appearance))
            .into();
        let Some(menu) = model.sidechain_menu else {
            return content;
        };
        let menu = sidechain_menu(model, menu, strings, appearance);
        let overlay = container(
            Row::new()
                .width(Length::Fill)
                .push(space::horizontal())
                .push(opaque(menu)),
        )
        .padding([model.toolbar_height as u16, ui_space::SM as u16])
        .width(Length::Fill)
        .height(Length::Fill)
        .align_y(iced_core::alignment::Vertical::Top);
        stack([content, overlay.into()]).into()
    }

}

fn native_select_trigger<'a>(
    label: String,
    menu: ToolbarMenu,
    width: f32,
    open: bool,
    enabled: bool,
    appearance: Appearance,
) -> EditorElement<'a> {
    let content = Row::new()
        .align_y(iced_core::alignment::Vertical::Center)
        .push(text(label).size(type_size::CONTROL))
        .push(space::horizontal())
        .push(text("▾").size(type_size::CONTROL));
    let trigger = button(content)
        .width(Length::Fixed(width))
        .height(Length::Fixed(heron_iced_ui::CONTROL_COMPACT))
        .padding([2, 6])
        .style(heron_iced_ui::select_trigger(appearance, open));
    let trigger = if enabled {
        trigger.on_press(Message::OpenToolbarMenu(menu))
    } else {
        trigger
    };
    mouse_area(trigger)
        .on_move(move |position| Message::ToolbarTriggerHovered(menu, position))
        .into()
}

struct ToolbarMenuContext<'a> {
    active_mode: PluginEditorMode,
    zoom_percent: u16,
    appearance: PluginEditorAppearance,
    effective_scale: f64,
    sidechain_buses: &'a [SidechainBus],
    sidechain_sources: &'a [SidechainSource],
    pending_sidechain: &'a Option<PendingSidechainRequest>,
}

fn toolbar_menu_request_for(
    menu: ToolbarMenu,
    anchor: Rectangle,
    context: ToolbarMenuContext<'_>,
) -> ToolbarMenuRequest {
    let ToolbarMenuContext {
        active_mode,
        zoom_percent,
        appearance,
        effective_scale,
        sidechain_buses,
        sidechain_sources,
        pending_sidechain,
    } = context;
    let strings = EditorStrings::for_locale(appearance.locale);
    let (options, selected) = match menu {
        ToolbarMenu::Mode => (
            vec![
                ToolbarMenuOption {
                    choice: ToolbarMenuChoice::Mode(PluginEditorMode::Native),
                    label: strings.editor.to_owned(),
                },
                ToolbarMenuOption {
                    choice: ToolbarMenuChoice::Mode(PluginEditorMode::Parameters),
                    label: strings.parameters.to_owned(),
                },
            ],
            ToolbarMenuChoice::Mode(active_mode),
        ),
        ToolbarMenu::Zoom => (
            zoom_options(zoom_percent)
                .into_iter()
                .map(|option| ToolbarMenuOption {
                    choice: ToolbarMenuChoice::Zoom(option.0),
                    label: option.to_string(),
                })
                .collect(),
            ToolbarMenuChoice::Zoom(zoom_percent),
        ),
        ToolbarMenu::Sidechain => {
            let options = sidechain_buses
                .iter()
                .flat_map(|bus| {
                    let disconnected = std::iter::once(ToolbarMenuOption {
                        choice: ToolbarMenuChoice::SidechainRoute {
                            input_bus_index: bus.input_bus_index,
                            source_channel_id: None,
                        },
                        label: format!("{} · {}", bus.name, strings.none),
                    });
                    let sources = sidechain_sources.iter().map(|source| {
                        let group = match source.kind {
                            SidechainSourceKind::Audio => strings.audio,
                            SidechainSourceKind::Instrument => strings.instrument,
                            SidechainSourceKind::Aux => strings.aux,
                        };
                        ToolbarMenuOption {
                            choice: ToolbarMenuChoice::SidechainRoute {
                                input_bus_index: bus.input_bus_index,
                                source_channel_id: Some(source.id.clone()),
                            },
                            label: format!("{} · {} · {}", bus.name, group, source.name),
                        }
                    });
                    disconnected.chain(sources)
                })
                .collect();
            let selected = sidechain_buses.first().map_or(
                ToolbarMenuChoice::SidechainRoute {
                    input_bus_index: 0,
                    source_channel_id: None,
                },
                |bus| {
                    let source_channel_id = pending_sidechain
                        .as_ref()
                        .filter(|pending| pending.input_bus_index == bus.input_bus_index)
                        .map(|pending| pending.displayed_source_channel_id.clone())
                        .unwrap_or_else(|| bus.source_channel_id.clone());
                    ToolbarMenuChoice::SidechainRoute {
                        input_bus_index: bus.input_bus_index,
                        source_channel_id,
                    }
                },
            );
            (options, selected)
        }
    };
    ToolbarMenuRequest {
        menu,
        anchor,
        options,
        selected,
        appearance: editor_appearance(appearance.theme),
        effective_scale,
    }
}

fn fallback_toolbar_anchor(
    logical_size: Size,
    menu: ToolbarMenu,
    has_sidechain: bool,
) -> Rectangle {
    let right_padding = ui_space::SM;
    let mode_width = 112.0;
    let zoom_width = 72.0;
    let sidechain_width = 112.0;
    let gap = ui_space::XS * 2.0;
    let (width, right_offset) = match menu {
        ToolbarMenu::Mode => (
            mode_width,
            right_padding
                + zoom_width
                + gap
                + if has_sidechain {
                    sidechain_width + gap
                } else {
                    0.0
                },
        ),
        ToolbarMenu::Zoom => (
            zoom_width,
            right_padding
                + if has_sidechain {
                    sidechain_width + gap
                } else {
                    0.0
                },
        ),
        ToolbarMenu::Sidechain => (sidechain_width, right_padding),
    };
    let y = if is_narrow_toolbar(logical_size.width) { 66.0 } else { 38.0 };
    Rectangle::new(
        Point::new((logical_size.width - right_offset - width).max(0.0), y),
        Size::new(width, heron_iced_ui::CONTROL_COMPACT),
    )
}

fn sidechain_key_action(
    sidechain_menu: &mut Option<SidechainMenuState>,
    sidechain_buses: &[SidechainBus],
    sidechain_sources: &[SidechainSource],
    key: &Key,
) -> (bool, bool, Option<EditorAction>) {
    let Some(mut menu) = *sidechain_menu else {
        return (false, false, None);
    };
    if matches!(key, Key::Named(NamedKey::Escape)) {
        return (true, true, None);
    }
    let source_count = source_count_for_group(sidechain_sources, menu.group);
    let length = match menu.level {
        0 => sidechain_buses.len(),
        1 => 4,
        _ => source_count,
    };
    match key {
        Key::Named(NamedKey::ArrowUp) => {
            menu.focused = menu.focused.saturating_sub(1);
        }
        Key::Named(NamedKey::ArrowDown) => {
            menu.focused = (menu.focused + 1).min(length.saturating_sub(1));
        }
        Key::Named(NamedKey::ArrowLeft) => {
            menu.level = menu.level.saturating_sub(1);
            menu.focused = if menu.level == 0 {
                menu.bus
            } else {
                menu.group.map_or(0, |group| match group {
                    SidechainSourceKind::Audio => 1,
                    SidechainSourceKind::Instrument => 2,
                    SidechainSourceKind::Aux => 3,
                })
            };
        }
        Key::Named(NamedKey::ArrowRight) | Key::Named(NamedKey::Enter) => {
            if menu.level == 0 {
                menu.bus = menu.focused;
                menu.level = 1;
                menu.focused = 0;
            } else if menu.level == 1 {
                if menu.focused == 0 {
                    let bus = sidechain_buses[menu.bus].input_bus_index;
                    *sidechain_menu = Some(menu);
                    return (
                        true,
                        false,
                        matches!(key, Key::Named(NamedKey::Enter)).then_some(
                            EditorAction::SidechainRoute {
                                input_bus_index: bus,
                                source_channel_id: None,
                            },
                        ),
                    );
                }
                menu.group = Some(match menu.focused {
                    1 => SidechainSourceKind::Audio,
                    2 => SidechainSourceKind::Instrument,
                    _ => SidechainSourceKind::Aux,
                });
                if source_count_for_group(sidechain_sources, menu.group) > 0 {
                    menu.level = 2;
                    menu.focused = 0;
                }
            } else if matches!(key, Key::Named(NamedKey::Enter)) {
                let Some(group) = menu.group else {
                    return (true, false, None);
                };
                let source = sidechain_sources
                    .iter()
                    .filter(|source| source.kind == group)
                    .nth(menu.focused);
                if let Some(source) = source {
                    let action = EditorAction::SidechainRoute {
                        input_bus_index: sidechain_buses[menu.bus].input_bus_index,
                        source_channel_id: Some(source.id.clone()),
                    };
                    *sidechain_menu = Some(menu);
                    return (true, false, Some(action));
                }
            }
        }
        _ => return (false, false, None),
    }
    *sidechain_menu = Some(menu);
    (true, false, None)
}

fn open_sidechain_menu(sidechain_menu: &mut Option<SidechainMenuState>) {
    *sidechain_menu = Some(SidechainMenuState {
        bus: 0,
        group: None,
        level: 0,
        focused: 0,
    });
}

fn select_sidechain_bus(sidechain_menu: &mut Option<SidechainMenuState>, bus: usize) {
    *sidechain_menu = Some(SidechainMenuState {
        bus,
        group: None,
        level: 1,
        focused: 0,
    });
}

fn select_sidechain_group(
    sidechain_menu: &mut Option<SidechainMenuState>,
    group: SidechainSourceKind,
) {
    if let Some(menu) = sidechain_menu {
        menu.group = Some(group);
        menu.level = 2;
        menu.focused = 0;
    }
}

fn sidechain_route_action(
    pending: bool,
    input_bus_index: u32,
    source_channel_id: Option<String>,
) -> Option<EditorAction> {
    (!pending).then_some(EditorAction::SidechainRoute {
        input_bus_index,
        source_channel_id,
    })
}

fn source_count_for_group(
    sources: &[SidechainSource],
    group: Option<SidechainSourceKind>,
) -> usize {
    group.map_or(0, |group| {
        sources.iter().filter(|source| source.kind == group).count()
    })
}

fn sidechain_menu<'a>(
    model: &'a EditorViewModel,
    menu: SidechainMenuState,
    strings: EditorStrings,
    appearance: Appearance,
) -> EditorElement<'a> {
    let pending_display = model.pending_sidechain.as_ref();
    let bus_entries = model
        .sidechain_buses
        .iter()
        .enumerate()
        .map(|(index, bus)| {
            let displayed_source = pending_display
                .filter(|pending| pending.input_bus_index == bus.input_bus_index)
                .map_or(bus.source_channel_id.as_ref(), |pending| {
                    pending.displayed_source_channel_id.as_ref()
                });
            let source_name = displayed_source
                .and_then(|source| model.sidechain_sources.iter().find(|item| &item.id == source))
                .map(|source| source.name.as_str())
                .unwrap_or(strings.none);
            CascadingMenuEntry {
                label: format!("{} · {}", bus.name, source_name).into(),
                message: Some(Message::SidechainBus(index)),
                selected: index == menu.bus,
                focused: menu.level == 0 && index == menu.focused,
                has_children: true,
            }
        })
        .collect::<Vec<_>>();
    let groups = [
        (None, strings.none),
        (Some(SidechainSourceKind::Audio), strings.audio),
        (Some(SidechainSourceKind::Instrument), strings.instrument),
        (Some(SidechainSourceKind::Aux), strings.aux),
    ];
    let bus = &model.sidechain_buses[menu.bus];
    let group_entries = groups
        .into_iter()
        .enumerate()
        .map(|(index, (group, label))| CascadingMenuEntry {
            label: label.into(),
            message: Some(match group {
                Some(group) => Message::SidechainGroup(group),
                None => Message::SidechainRoute(bus.input_bus_index, None),
            }),
            selected: group.is_some_and(|group| Some(group) == menu.group),
            focused: menu.level == 1 && index == menu.focused,
            has_children: group.is_some(),
        })
        .collect::<Vec<_>>();
    let mut columns = vec![bus_entries, group_entries];
    if let Some(group) = menu.group {
        columns.push(
            model
                .sidechain_sources
                .iter()
                .filter(|source| source.kind == group)
                .enumerate()
                .map(|(index, source)| CascadingMenuEntry {
                    label: source.name.clone().into(),
                    message: Some(Message::SidechainRoute(
                        bus.input_bus_index,
                        Some(source.id.clone()),
                    )),
                    selected: bus.source_channel_id.as_ref() == Some(&source.id),
                    focused: menu.level == 2 && index == menu.focused,
                    has_children: false,
                })
                .collect(),
        );
    }
    heron_iced_ui::cascading_menu(columns, appearance)
}

fn compact_button<'a>(
    label: &'a str,
    message: Message,
    enabled: bool,
    appearance: Appearance,
) -> button::Button<'a, Message, Theme, Renderer> {
    let content = container(text(label).size(type_size::CONTROL))
        .padding([0, 8])
        .center_y(Length::Fill);
    let button = button(content)
        .height(Length::Fixed(heron_iced_ui::CONTROL_COMPACT))
        .padding(0)
        .style(heron_iced_ui::action_button(appearance));
    if enabled {
        button.on_press(message)
    } else {
        button
    }
}

fn compare_segment_button<'a>(
    label: &'a str,
    message: Message,
    enabled: bool,
    selected: bool,
    appearance: Appearance,
) -> button::Button<'a, Message, Theme, Renderer> {
    let content = container(text(label).size(type_size::CONTROL)).center(Length::Fill);
    let button = button(content)
        .width(Length::Fixed(COMPARE_SEGMENT_WIDTH))
        .height(Length::Fill)
        .padding(0)
        .style(heron_iced_ui::segmented_button(appearance, selected));
    if enabled {
        button.on_press(message)
    } else {
        button
    }
}

fn editor_appearance(theme: PluginEditorTheme) -> Appearance {
    match theme {
        PluginEditorTheme::Light => Appearance::Light,
        PluginEditorTheme::Dark => Appearance::Dark,
    }
}

fn parse_signal_color(value: &str) -> Option<Color> {
    let value = value.strip_prefix('#')?;
    if value.len() != 6 {
        return None;
    }
    let packed = u32::from_str_radix(value, 16).ok()?;
    Some(Color::from_rgb8(
        u8::try_from((packed >> 16) & 0xff).ok()?,
        u8::try_from((packed >> 8) & 0xff).ok()?,
        u8::try_from(packed & 0xff).ok()?,
    ))
}
