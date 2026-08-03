//! Shared iced foundations for YADAW's host chrome and built-in plug-ins.

use std::borrow::Cow;

use iced_core::{Background, Border, Color, Element, Length, Shadow, theme::Palette};
use iced_widget::{Column, Row, Theme, button, container, pick_list, slider, text, text_input};

/// Compact DAW control height in logical pixels.
pub const CONTROL_COMPACT: f32 = 24.0;
/// Small control height in logical pixels.
pub const CONTROL_SMALL: f32 = 32.0;
/// The plug-in editor chrome height in logical pixels.
pub const EDITOR_CHROME_HEIGHT: f32 = 72.0;
/// Width of the active signal rail.
pub const SIGNAL_RAIL_WIDTH: f32 = 3.0;

/// One entry in a host-owned cascading menu column.
#[derive(Debug, Clone)]
pub struct CascadingMenuEntry<'a, Message> {
    pub label: Cow<'a, str>,
    pub message: Option<Message>,
    pub selected: bool,
    pub focused: bool,
    pub has_children: bool,
}

/// Build the shared visual surface for a multi-level host menu. Navigation
/// state stays with the owning feature so the component can be reused for
/// route, preset, and device hierarchies.
pub fn cascading_menu<'a, Message: Clone + 'a>(
    columns: impl IntoIterator<Item = Vec<CascadingMenuEntry<'a, Message>>>,
    appearance: Appearance,
) -> Element<'a, Message, Theme, iced_widget::Renderer> {
    let colors = appearance.palette();
    let columns = columns
        .into_iter()
        .fold(Row::new().spacing(space::XS), |row, entries| {
            let column = entries
                .into_iter()
                .fold(Column::new().spacing(1), |column, entry| {
                    let marker = if entry.selected { "✓" } else { " " };
                    let child = if entry.has_children { "›" } else { "" };
                    let content = Row::new()
                        .spacing(space::SM)
                        .push(text(marker).size(type_size::CONTROL))
                        .push(text(entry.label).size(type_size::CONTROL))
                        .push(iced_widget::space::horizontal())
                        .push(text(child).size(type_size::CONTROL));
                    let control = button(content)
                        .width(Length::Fixed(190.0))
                        .height(Length::Fixed(CONTROL_COMPACT))
                        .padding([0, 6])
                        .style(segmented_button(
                            appearance,
                            entry.selected || entry.focused,
                        ));
                    column.push(match entry.message {
                        Some(message) => control.on_press(message),
                        None => control,
                    })
                });
            row.push(
                container(column)
                    .padding(space::XS)
                    .style(move |_| container::Style {
                        text_color: Some(colors.text),
                        background: Some(colors.surface_raised.into()),
                        border: Border {
                            radius: 4.0.into(),
                            width: 1.0,
                            color: colors.border_strong,
                        },
                        shadow: Shadow {
                            color: Color {
                                a: 0.32,
                                ..Color::BLACK
                            },
                            offset: iced_core::Vector::new(0.0, 4.0),
                            blur_radius: 12.0,
                        },
                        ..container::Style::default()
                    }),
            )
        });
    container(columns).into()
}

/// Four-pixel spatial scale used by native YADAW interfaces.
pub mod space {
    pub const XS: f32 = 4.0;
    pub const SM: f32 = 8.0;
    pub const MD: f32 = 12.0;
    pub const LG: f32 = 16.0;
    pub const XL: f32 = 24.0;
}

/// Dense typography roles used by editor chrome.
pub mod type_size {
    pub const CAPTION: f32 = 11.0;
    pub const CONTROL: f32 = 12.0;
    pub const BODY_COMPACT: f32 = 13.0;
    pub const PANEL_TITLE: f32 = 15.0;
}

/// Resolved application appearance used by host-owned iced surfaces.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Appearance {
    Light,
    #[default]
    Dark,
}

/// Semantic colors corresponding to the renderer design system.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SemanticPalette {
    pub canvas: Color,
    pub canvas_subtle: Color,
    pub surface: Color,
    pub surface_raised: Color,
    pub control: Color,
    pub control_hover: Color,
    pub control_pressed: Color,
    pub text: Color,
    pub text_muted: Color,
    pub text_subtle: Color,
    pub border: Color,
    pub border_strong: Color,
    pub action: Color,
    pub action_hover: Color,
    pub action_pressed: Color,
    pub action_text: Color,
    pub selection: Color,
    pub selection_hover: Color,
    pub selection_border: Color,
    pub focus: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
    pub audio: Color,
    pub midi: Color,
}

impl Appearance {
    /// Resolve the complete semantic palette for this appearance.
    #[must_use]
    pub const fn palette(self) -> SemanticPalette {
        match self {
            Self::Dark => {
                let surface = rgb(0x1d2128);
                let action = rgb(0x8da8b5);
                let border = rgb(0x383e48);
                SemanticPalette {
                    canvas: rgb(0x0e1014),
                    canvas_subtle: rgb(0x171a20),
                    surface,
                    surface_raised: rgb(0x252a32),
                    control: rgb(0x252a32),
                    control_hover: rgb(0x383e48),
                    control_pressed: rgb(0x171a20),
                    text: rgb(0xf6f7f9),
                    text_muted: rgb(0xaeb4bf),
                    text_subtle: rgb(0x8d95a2),
                    border: rgb(0x383e48),
                    border_strong: rgb(0x515966),
                    action,
                    action_hover: rgb(0xb6cbd3),
                    action_pressed: rgb(0x6f929f),
                    action_text: rgb(0x0e1014),
                    selection: mix(action, 0.14, surface),
                    selection_hover: mix(action, 0.20, surface),
                    selection_border: mix(action, 0.72, border),
                    focus: rgb(0x8eb9c8),
                    success: rgb(0x59d79a),
                    warning: rgb(0xf4bd62),
                    danger: rgb(0xff6b72),
                    audio: rgb(0x58c6c2),
                    midi: rgb(0xad8cff),
                }
            }
            Self::Light => {
                let surface = rgb(0xececee);
                let action = rgb(0x456d7a);
                let border = rgb(0xc4c5c7);
                SemanticPalette {
                    canvas: rgb(0xd8d9db),
                    canvas_subtle: rgb(0xe4e5e7),
                    surface,
                    surface_raised: rgb(0xf3f3f4),
                    control: rgb(0xe8e8e9),
                    control_hover: rgb(0xf2f2f3),
                    control_pressed: rgb(0xc8d0d4),
                    text: rgb(0x202224),
                    text_muted: rgb(0x676c70),
                    text_subtle: rgb(0x858a8e),
                    border: rgb(0xc4c5c7),
                    border_strong: rgb(0xaaadb0),
                    action,
                    action_hover: rgb(0x355d6b),
                    action_pressed: rgb(0x365e6b),
                    action_text: Color::WHITE,
                    selection: mix(action, 0.12, surface),
                    selection_hover: mix(action, 0.18, surface),
                    selection_border: mix(action, 0.72, border),
                    focus: rgb(0x2f758b),
                    success: rgb(0x16764c),
                    warning: rgb(0x8a5700),
                    danger: rgb(0xb4232d),
                    audio: rgb(0x167a77),
                    midi: rgb(0x704fc0),
                }
            }
        }
    }

    /// Build an iced theme with YADAW's semantic base colors.
    #[must_use]
    pub fn theme(self) -> Theme {
        let colors = self.palette();
        Theme::custom(
            match self {
                Self::Dark => "YADAW Dark",
                Self::Light => "YADAW Light",
            },
            Palette {
                background: colors.canvas,
                text: colors.text,
                primary: colors.action,
                success: colors.success,
                warning: colors.warning,
                danger: colors.danger,
            },
        )
    }
}

/// Style a neutral command button.
pub fn action_button(
    appearance: Appearance,
) -> impl Fn(&Theme, button::Status) -> button::Style + Clone {
    move |_, status| {
        let colors = appearance.palette();
        let (background, text_color, border_color) = match status {
            button::Status::Disabled => (colors.surface, colors.text_subtle, colors.border),
            button::Status::Hovered => (colors.control_hover, colors.text, colors.border_strong),
            button::Status::Pressed => (colors.control_pressed, colors.text, colors.border_strong),
            button::Status::Active => (colors.control, colors.text, colors.border),
        };
        button::Style {
            background: Some(background.into()),
            text_color,
            border: Border {
                radius: 4.0.into(),
                width: 1.0,
                color: border_color,
            },
            shadow: Shadow::default(),
            ..button::Style::default()
        }
    }
}

/// Style the single outline and shared surface of an exclusive segmented control.
pub fn segmented_group(
    appearance: Appearance,
    enabled: bool,
) -> impl Fn(&Theme) -> container::Style + Clone {
    move |_| {
        let colors = appearance.palette();
        let background = if enabled {
            colors.control_pressed
        } else {
            mix(colors.control_pressed, 0.55, colors.surface)
        };
        container::Style {
            text_color: Some(if enabled {
                colors.text
            } else {
                colors.text_subtle
            }),
            background: Some(background.into()),
            border: Border {
                radius: 4.0.into(),
                width: 1.0,
                color: if enabled {
                    colors.border
                } else {
                    mix(colors.border, 0.55, background)
                },
            },
            ..container::Style::default()
        }
    }
}

/// Style one item inside an exclusive segmented control.
///
/// The group owns the only outline. A selected disabled item retains a muted
/// selection tint so the control still communicates its current value.
pub fn segmented_button(
    appearance: Appearance,
    selected: bool,
) -> impl Fn(&Theme, button::Status) -> button::Style + Clone {
    move |_, status| {
        let colors = appearance.palette();
        let (background, text_color) = match (selected, status) {
            (true, button::Status::Disabled) => (
                Some(mix(colors.selection, 0.55, colors.control_pressed)),
                mix(colors.text, 0.55, colors.control_pressed),
            ),
            (false, button::Status::Disabled) => {
                (None, mix(colors.text_muted, 0.55, colors.control_pressed))
            }
            (true, button::Status::Hovered | button::Status::Pressed) => {
                (Some(colors.selection_hover), colors.text)
            }
            (true, button::Status::Active) => (Some(colors.selection), colors.text),
            (false, button::Status::Hovered) => (Some(colors.control_hover), colors.text),
            (false, button::Status::Pressed) => (Some(colors.control), colors.text),
            (false, button::Status::Active) => (None, colors.text_muted),
        };
        button::Style {
            background: background.map(Background::Color),
            text_color,
            border: Border {
                radius: 3.0.into(),
                width: 0.0,
                color: Color::TRANSPARENT,
            },
            shadow: Shadow::default(),
            ..button::Style::default()
        }
    }
}

/// Style a chrome or content surface.
pub fn surface(
    appearance: Appearance,
    raised: bool,
) -> impl Fn(&Theme) -> container::Style + Clone {
    move |_| {
        let colors = appearance.palette();
        container::Style {
            text_color: Some(colors.text),
            background: Some(
                if raised {
                    colors.surface_raised
                } else {
                    colors.surface
                }
                .into(),
            ),
            border: Border {
                radius: if raised { 8.0 } else { 4.0 }.into(),
                width: 1.0,
                color: colors.border,
            },
            ..container::Style::default()
        }
    }
}

/// Style a full-bleed editor chrome region.
pub fn chrome(appearance: Appearance) -> impl Fn(&Theme) -> container::Style + Clone {
    move |_| {
        let colors = appearance.palette();
        container::Style {
            text_color: Some(colors.text),
            background: Some(colors.canvas_subtle.into()),
            border: Border {
                radius: 0.0.into(),
                width: 0.0,
                color: Color::TRANSPARENT,
            },
            ..container::Style::default()
        }
    }
}

/// Style the editor content canvas.
pub fn canvas(appearance: Appearance) -> impl Fn(&Theme) -> container::Style + Clone {
    move |_| {
        let colors = appearance.palette();
        container::Style {
            text_color: Some(colors.text),
            background: Some(colors.canvas.into()),
            ..container::Style::default()
        }
    }
}

/// Style a compact select control.
pub fn select(
    appearance: Appearance,
) -> impl Fn(&Theme, pick_list::Status) -> pick_list::Style + Clone {
    move |_, status| {
        let colors = appearance.palette();
        let background = match status {
            pick_list::Status::Hovered | pick_list::Status::Opened { .. } => colors.control_hover,
            pick_list::Status::Active => colors.control,
        };
        pick_list::Style {
            text_color: colors.text,
            placeholder_color: colors.text_subtle,
            handle_color: colors.text_muted,
            background: background.into(),
            border: Border {
                radius: 4.0.into(),
                width: 1.0,
                color: colors.border_strong,
            },
        }
    }
}

/// Style a select trigger whose menu is rendered in a separate native window.
pub fn select_trigger(
    appearance: Appearance,
    open: bool,
) -> impl Fn(&Theme, button::Status) -> button::Style + Clone {
    move |_, status| {
        let colors = appearance.palette();
        let background = match (open, status) {
            (_, button::Status::Disabled) => colors.surface,
            (true, _) | (_, button::Status::Hovered) => colors.control_hover,
            (_, button::Status::Pressed) => colors.control_pressed,
            (false, button::Status::Active) => colors.control,
        };
        button::Style {
            background: Some(background.into()),
            text_color: if matches!(status, button::Status::Disabled) {
                colors.text_subtle
            } else {
                colors.text
            },
            border: Border {
                radius: 4.0.into(),
                width: if open { 2.0 } else { 1.0 },
                color: if open {
                    colors.focus
                } else {
                    colors.border_strong
                },
            },
            shadow: Shadow::default(),
            ..button::Style::default()
        }
    }
}

/// Style the surface of a native toolbar menu window.
pub fn popup_surface(appearance: Appearance) -> impl Fn(&Theme) -> container::Style + Clone {
    move |_| {
        let colors = appearance.palette();
        container::Style {
            text_color: Some(colors.text),
            background: Some(colors.surface_raised.into()),
            border: Border {
                radius: 4.0.into(),
                width: 1.0,
                color: colors.border_strong,
            },
            shadow: Shadow::default(),
            ..container::Style::default()
        }
    }
}

/// Style one row in a native toolbar menu window.
pub fn popup_menu_row(
    appearance: Appearance,
    selected: bool,
    focused: bool,
) -> impl Fn(&Theme, button::Status) -> button::Style + Clone {
    move |_, status| {
        let colors = appearance.palette();
        let background = match (selected, focused, status) {
            (_, _, button::Status::Pressed) => Some(colors.selection_hover),
            (_, _, button::Status::Hovered) | (_, true, _) => Some(colors.selection_hover),
            (true, false, _) => Some(colors.selection),
            (false, false, _) => None,
        };
        button::Style {
            background: background.map(Background::Color),
            text_color: colors.text,
            border: Border {
                radius: 3.0.into(),
                width: if focused { 1.0 } else { 0.0 },
                color: if focused {
                    colors.focus
                } else {
                    Color::TRANSPARENT
                },
            },
            shadow: Shadow::default(),
            ..button::Style::default()
        }
    }
}

/// Style the compact percentage input.
pub fn number_input(
    appearance: Appearance,
) -> impl Fn(&Theme, text_input::Status) -> text_input::Style + Clone {
    move |_, status| {
        let colors = appearance.palette();
        let (background, border) = match status {
            text_input::Status::Focused { .. } => (colors.surface_raised, colors.focus),
            text_input::Status::Hovered => (colors.control_hover, colors.border_strong),
            text_input::Status::Disabled => (colors.surface, colors.border),
            text_input::Status::Active => (colors.control, colors.border),
        };
        text_input::Style {
            background: background.into(),
            border: Border {
                radius: 4.0.into(),
                width: if matches!(status, text_input::Status::Focused { .. }) {
                    2.0
                } else {
                    1.0
                },
                color: border,
            },
            icon: colors.text_muted,
            placeholder: colors.text_subtle,
            value: colors.text,
            selection: colors.action,
        }
    }
}

/// Style a parameter slider with signal-led fill.
pub fn parameter_slider(
    appearance: Appearance,
) -> impl Fn(&Theme, slider::Status) -> slider::Style + Clone {
    move |_, status| {
        let colors = appearance.palette();
        let handle = match status {
            slider::Status::Active => colors.text_muted,
            slider::Status::Hovered | slider::Status::Dragged => colors.action_hover,
        };
        slider::Style {
            rail: slider::Rail {
                backgrounds: (colors.audio.into(), colors.control.into()),
                width: 4.0,
                border: Border {
                    radius: 2.0.into(),
                    width: 0.0,
                    color: Color::TRANSPARENT,
                },
            },
            handle: slider::Handle {
                shape: slider::HandleShape::Circle { radius: 6.0 },
                background: Background::Color(handle),
                border_width: 1.0,
                border_color: colors.border_strong,
            },
        }
    }
}

const fn rgb(value: u32) -> Color {
    Color::from_rgb8(
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    )
}

const fn mix(foreground: Color, amount: f32, background: Color) -> Color {
    let inverse = 1.0 - amount;
    Color {
        r: foreground.r * amount + background.r * inverse,
        g: foreground.g * amount + background.g * inverse,
        b: foreground.b * amount + background.b * inverse,
        a: foreground.a * amount + background.a * inverse,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appearances_keep_distinct_surface_and_text_colors() {
        for appearance in [Appearance::Dark, Appearance::Light] {
            let palette = appearance.palette();
            assert_ne!(palette.canvas, palette.surface);
            assert_ne!(palette.surface, palette.text);
            assert_ne!(palette.control, palette.action);
        }
    }

    #[test]
    fn compact_geometry_uses_the_four_pixel_grid() {
        assert_eq!(CONTROL_COMPACT % space::XS, 0.0);
        assert_eq!(EDITOR_CHROME_HEIGHT % space::XS, 0.0);
        const { assert!(SIGNAL_RAIL_WIDTH < space::XS) };
    }

    #[test]
    fn segmented_controls_use_one_outline_and_keep_one_visible_selection() {
        for appearance in [Appearance::Dark, Appearance::Light] {
            let theme = appearance.theme();
            let selected = segmented_button(appearance, true)(&theme, button::Status::Active);
            let unselected = segmented_button(appearance, false)(&theme, button::Status::Active);
            let selected_disabled =
                segmented_button(appearance, true)(&theme, button::Status::Disabled);
            let unselected_disabled =
                segmented_button(appearance, false)(&theme, button::Status::Disabled);
            let group = segmented_group(appearance, true)(&theme);

            assert_ne!(selected.background, unselected.background);
            assert_ne!(selected_disabled.background, unselected_disabled.background);
            assert_eq!(selected.border.width, 0.0);
            assert_eq!(unselected.border.width, 0.0);
            assert_eq!(group.border.width, 1.0);
        }
    }

    #[test]
    fn disabled_actions_are_visually_distinct_from_available_actions() {
        for appearance in [Appearance::Dark, Appearance::Light] {
            let theme = appearance.theme();
            let active = action_button(appearance)(&theme, button::Status::Active);
            let disabled = action_button(appearance)(&theme, button::Status::Disabled);

            assert_ne!(active.background, disabled.background);
            assert_ne!(active.text_color, disabled.text_color);
            assert_eq!(disabled.shadow, Shadow::default());
        }
    }

    #[test]
    fn action_and_segmented_styles_cover_all_interaction_states() {
        for appearance in [Appearance::Dark, Appearance::Light] {
            let theme = appearance.theme();
            let action = action_button(appearance);
            let active = action(&theme, button::Status::Active);
            let hovered = action(&theme, button::Status::Hovered);
            let pressed = action(&theme, button::Status::Pressed);
            assert_ne!(active.background, hovered.background);
            assert_ne!(hovered.background, pressed.background);

            let selected = segmented_button(appearance, true);
            assert_ne!(
                selected(&theme, button::Status::Active).background,
                selected(&theme, button::Status::Hovered).background
            );
            assert_eq!(
                selected(&theme, button::Status::Hovered).background,
                selected(&theme, button::Status::Pressed).background
            );

            let unselected = segmented_button(appearance, false);
            assert_ne!(
                unselected(&theme, button::Status::Active).background,
                unselected(&theme, button::Status::Hovered).background
            );
            assert_ne!(
                unselected(&theme, button::Status::Hovered).background,
                unselected(&theme, button::Status::Pressed).background
            );
        }
    }

    #[test]
    fn surface_styles_resolve_every_semantic_layer() {
        for appearance in [Appearance::Dark, Appearance::Light] {
            let theme = appearance.theme();
            let flat = surface(appearance, false)(&theme);
            let raised = surface(appearance, true)(&theme);
            let chrome = chrome(appearance)(&theme);
            let canvas = canvas(appearance)(&theme);

            assert_ne!(flat.background, raised.background);
            assert_ne!(chrome.background, canvas.background);
            assert_eq!(flat.border.radius, 4.0.into());
            assert_eq!(raised.border.radius, 8.0.into());
        }
    }

    #[test]
    fn select_number_input_and_slider_styles_cover_all_states() {
        for appearance in [Appearance::Dark, Appearance::Light] {
            let theme = appearance.theme();
            let select = select(appearance);
            let select_active = select(&theme, pick_list::Status::Active);
            let select_hovered = select(&theme, pick_list::Status::Hovered);
            let select_open = select(&theme, pick_list::Status::Opened { is_hovered: false });
            assert_ne!(select_active.background, select_hovered.background);
            assert_eq!(select_hovered.background, select_open.background);

            let input = number_input(appearance);
            let input_active = input(&theme, text_input::Status::Active);
            let input_hovered = input(&theme, text_input::Status::Hovered);
            let input_focused = input(&theme, text_input::Status::Focused { is_hovered: false });
            let input_disabled = input(&theme, text_input::Status::Disabled);
            assert_ne!(input_active.background, input_hovered.background);
            assert_eq!(input_focused.border.width, 2.0);
            assert_ne!(input_disabled.background, input_hovered.background);

            let slider = parameter_slider(appearance);
            let slider_active = slider(&theme, slider::Status::Active);
            let slider_hovered = slider(&theme, slider::Status::Hovered);
            let slider_dragged = slider(&theme, slider::Status::Dragged);
            assert_ne!(
                slider_active.handle.background,
                slider_hovered.handle.background
            );
            assert_eq!(
                slider_hovered.handle.background,
                slider_dragged.handle.background
            );
        }
    }

    #[test]
    fn native_select_trigger_and_popup_styles_cover_all_states() {
        for appearance in [Appearance::Dark, Appearance::Light] {
            let theme = appearance.theme();
            let closed = select_trigger(appearance, false);
            let open = select_trigger(appearance, true);
            assert_ne!(
                closed(&theme, button::Status::Active).border,
                open(&theme, button::Status::Active).border
            );
            assert_ne!(
                closed(&theme, button::Status::Active).background,
                closed(&theme, button::Status::Hovered).background
            );

            let normal = popup_menu_row(appearance, false, false);
            let selected = popup_menu_row(appearance, true, false);
            let focused = popup_menu_row(appearance, false, true);
            assert_ne!(
                normal(&theme, button::Status::Active).background,
                selected(&theme, button::Status::Active).background
            );
            assert_eq!(
                selected(&theme, button::Status::Hovered).background,
                focused(&theme, button::Status::Active).background
            );
            assert_eq!(focused(&theme, button::Status::Active).border.width, 1.0);

            let surface = popup_surface(appearance)(&theme);
            assert_eq!(
                surface.background,
                Some(appearance.palette().surface_raised.into())
            );
            assert_eq!(surface.border.width, 1.0);
        }
    }
}
