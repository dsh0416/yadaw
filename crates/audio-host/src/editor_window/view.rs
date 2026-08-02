const VST3_PARAMETER_FLAG_READ_ONLY: u32 = 1 << 1;

impl EditorWindow {
    fn update(&mut self, message: Message, actions: &mut Vec<EditorAction>) {
        match message {
            Message::UseMode(mode) => {
                self.close_toolbar_menu();
                if mode != self.preference.mode {
                    actions.push(EditorAction::PreferenceChanged(PluginEditorPreference {
                        mode,
                        zoom_percent: self.preference.zoom_percent,
                    }));
                }
            }
            Message::ZoomPreset(zoom_percent) => {
                self.close_toolbar_menu();
                actions.push(EditorAction::PreferenceChanged(PluginEditorPreference {
                    mode: self.preference.mode,
                    zoom_percent,
                }));
            }
            Message::ZoomInput(value) => {
                self.zoom_input = value;
                self.zoom_dirty = true;
            }
            Message::ZoomSubmit => {
                if let Some(action) = self.commit_zoom_input() {
                    actions.push(action);
                }
            }
            Message::MenuOpened(menu) => {
                self.open_menu = Some(menu);
                self.set_native_visible(false);
            }
            Message::MenuClosed(menu) => {
                if self.open_menu == Some(menu) {
                    self.open_menu = None;
                    self.set_native_visible(true);
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
        EditorViewModel {
            zoom_input: self.zoom_input.clone(),
            zoom_percent: self.preference.zoom_percent,
            active_mode: self.active_mode,
            warning: self.warning.clone(),
            parameters: if self.active_mode == PluginEditorMode::Parameters {
                self.parameters.clone()
            } else {
                Vec::new()
            },
        }
    }

    fn view(model: &EditorViewModel) -> EditorElement<'_> {
        let mode = pick_list(
            MODE_OPTIONS,
            Some(EditorModeOption::from(model.active_mode)),
            |option| Message::UseMode(option.into()),
        )
        .on_open(Message::MenuOpened(ToolbarMenu::Mode))
        .on_close(Message::MenuClosed(ToolbarMenu::Mode))
        .width(112);
        let zoom_options = ZOOM_PRESETS.map(ZoomOption);
        let zoom = pick_list(
            zoom_options,
            Some(ZoomOption(model.zoom_percent)),
            |option| Message::ZoomPreset(option.0),
        )
        .on_open(Message::MenuOpened(ToolbarMenu::Zoom))
        .on_close(Message::MenuClosed(ToolbarMenu::Zoom))
        .width(76);
        let toolbar = Row::new()
            .spacing(6)
            .padding([12, 10])
            .height(Length::Fixed(TOOLBAR_HEIGHT as f32))
            .push(mode)
            .push(zoom)
            .push(space::horizontal())
            .push(
                text_input("50–400", &model.zoom_input)
                    .on_input(Message::ZoomInput)
                    .on_submit(Message::ZoomSubmit)
                    .width(62),
            )
            .push(text("%"));

        let mut content = Column::new().push(toolbar);
        if let Some(warning) = &model.warning {
            content = content.push(
                container(text(warning).size(13))
                    .padding([6, 14])
                    .width(Length::Fill),
            );
        }

        if model.active_mode == PluginEditorMode::Parameters {
            let parameter_list = if model.parameters.is_empty() {
                Column::new().push(
                    container(text("This plug-in has no editable parameters"))
                        .padding(24)
                        .width(Length::Fill),
                )
            } else {
                model.parameters.iter().fold(
                    Column::new().spacing(10).padding([12, 16]),
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
                                container(text(value_text.clone())).width(Length::Fill).into()
                            } else {
                                slider(0.0..=1.0, value, move |normalized| {
                                    Message::ParameterChanged(id, normalized)
                                })
                                .step(step)
                                .on_release(Message::ParameterReleased(id))
                                .into()
                            };
                        column.push(
                            Column::new()
                                .spacing(5)
                                .push(
                                    Row::new()
                                        .push(text(&parameter.title))
                                        .push(space::horizontal())
                                        .push(text(value_text.clone()).size(13)),
                                )
                                .push(control),
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
            .into()
    }

    fn commit_zoom_input(&mut self) -> Option<EditorAction> {
        let Ok(value) = self.zoom_input.parse::<u16>() else {
            return None;
        };
        if !(50..=400).contains(&value) {
            return None;
        }
        self.zoom_dirty = false;
        if value == self.preference.zoom_percent {
            return None;
        }
        Some(EditorAction::PreferenceChanged(PluginEditorPreference {
            mode: self.preference.mode,
            zoom_percent: value,
        }))
    }
}
