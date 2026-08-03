const VST3_PARAMETER_FLAG_READ_ONLY: u32 = 1 << 1;

impl EditorWindow {
    fn update(&mut self, message: Message, actions: &mut Vec<EditorAction>) {
        match message {
            Message::UseMode(mode) => {
                self.compare_segment_focused = false;
                self.close_toolbar_menu();
                if mode != self.preference.mode {
                    actions.push(EditorAction::PreferenceChanged(PluginEditorPreference {
                        mode,
                        zoom_percent: self.preference.zoom_percent,
                    }));
                }
            }
            Message::UseCompareSlot(slot) => {
                self.compare_segment_focused = true;
                actions.push(EditorAction::UseCompareSlot(slot));
            }
            Message::CopyState => actions.push(EditorAction::CopyState),
            Message::PasteState => actions.push(EditorAction::PasteState),
            Message::Undo => actions.push(EditorAction::Undo),
            Message::Redo => actions.push(EditorAction::Redo),
            Message::ZoomPreset(zoom_percent) => {
                self.compare_segment_focused = false;
                self.close_toolbar_menu();
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
                    };
                    self.toolbar_anchors.insert(
                        menu,
                        Rectangle::new(
                            Point::new(
                                cursor.x - local_position.x,
                                cursor.y - local_position.y,
                            ),
                            Size::new(width, yadaw_iced_ui::CONTROL_COMPACT),
                        ),
                    );
                }
            }
            Message::OpenToolbarMenu(menu) => {
                self.compare_segment_focused = false;
                self.open_menu = Some(menu);
                let anchor = self
                    .toolbar_anchors
                    .get(&menu)
                    .copied()
                    .unwrap_or_else(|| fallback_toolbar_anchor(self.viewport.logical_size(), menu));
                actions.push(EditorAction::OpenToolbarMenu(self.toolbar_menu_request(menu, anchor)));
            }
            Message::MenuOpened(menu) => {
                self.compare_segment_focused = false;
                self.open_menu = Some(menu);
            }
            Message::MenuClosed(menu) => {
                if self.open_menu == Some(menu) {
                    self.open_menu = None;
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
                appearance,
            )
        } else {
            pick_list(mode_options, selected_mode, |option| Message::UseMode(option.mode))
                .on_open(Message::MenuOpened(ToolbarMenu::Mode))
                .on_close(Message::MenuClosed(ToolbarMenu::Mode))
                .style(yadaw_iced_ui::select(appearance))
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
            .style(yadaw_iced_ui::select(appearance))
            .text_size(type_size::CONTROL)
            .padding([2, 6])
            .width(72)
            .into()
        };

        let signal_color = parse_signal_color(&model.context.channel_color).unwrap_or(colors.action);
        let signal_rail = container(space::vertical())
            .width(Length::Fixed(yadaw_iced_ui::SIGNAL_RAIL_WIDTH))
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
            .height(Length::Fixed(yadaw_iced_ui::CONTROL_COMPACT))
            .padding(1)
            .style(yadaw_iced_ui::segmented_group(
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
        .style(yadaw_iced_ui::chrome(appearance));

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
                                .style(yadaw_iced_ui::parameter_slider(appearance))
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
                            .style(yadaw_iced_ui::surface(appearance, false)),
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
        container(content)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(yadaw_iced_ui::canvas(appearance))
            .into()
    }

}

fn native_select_trigger<'a>(
    label: String,
    menu: ToolbarMenu,
    width: f32,
    open: bool,
    appearance: Appearance,
) -> EditorElement<'a> {
    let content = Row::new()
        .align_y(iced_core::alignment::Vertical::Center)
        .push(text(label).size(type_size::CONTROL))
        .push(space::horizontal())
        .push(text("▾").size(type_size::CONTROL));
    let trigger = button(content)
        .on_press(Message::OpenToolbarMenu(menu))
        .width(Length::Fixed(width))
        .height(Length::Fixed(yadaw_iced_ui::CONTROL_COMPACT))
        .padding([2, 6])
        .style(yadaw_iced_ui::select_trigger(appearance, open));
    mouse_area(trigger)
        .on_move(move |position| Message::ToolbarTriggerHovered(menu, position))
        .into()
}

impl EditorWindow {
    fn toolbar_menu_request(
        &self,
        menu: ToolbarMenu,
        anchor: Rectangle,
    ) -> ToolbarMenuRequest {
        let strings = EditorStrings::for_locale(self.context.appearance.locale);
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
                ToolbarMenuChoice::Mode(self.active_mode),
            ),
            ToolbarMenu::Zoom => (
                zoom_options(self.preference.zoom_percent)
                    .into_iter()
                    .map(|option| ToolbarMenuOption {
                        choice: ToolbarMenuChoice::Zoom(option.0),
                        label: option.to_string(),
                    })
                    .collect(),
                ToolbarMenuChoice::Zoom(self.preference.zoom_percent),
            ),
        };
        ToolbarMenuRequest {
            menu,
            anchor,
            options,
            selected,
            appearance: editor_appearance(self.context.appearance.theme),
            effective_scale: self.effective_scale(),
        }
    }
}

fn fallback_toolbar_anchor(logical_size: Size, menu: ToolbarMenu) -> Rectangle {
    let right_padding = ui_space::SM;
    let zoom_width = 72.0;
    let gap = ui_space::XS * 2.0;
    let (width, right_offset) = match menu {
        ToolbarMenu::Mode => (112.0, right_padding + zoom_width + gap),
        ToolbarMenu::Zoom => (zoom_width, right_padding),
    };
    let y = if is_narrow_toolbar(logical_size.width) { 66.0 } else { 38.0 };
    Rectangle::new(
        Point::new((logical_size.width - right_offset - width).max(0.0), y),
        Size::new(width, yadaw_iced_ui::CONTROL_COMPACT),
    )
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
        .height(Length::Fixed(yadaw_iced_ui::CONTROL_COMPACT))
        .padding(0)
        .style(yadaw_iced_ui::action_button(appearance));
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
        .style(yadaw_iced_ui::segmented_button(appearance, selected));
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
