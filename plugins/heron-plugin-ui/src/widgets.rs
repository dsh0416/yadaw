use std::{fmt::Debug, marker::PhantomData};

use truce::{
    core::{Float, util::meter_display},
    params::Params,
};
use truce_iced::{
    Message, ParamCache, ParamMessage,
    iced::{
        Element, Font, Length, Pixels, Point, Rectangle, Renderer, Size, Theme, alignment, mouse,
        widget::{
            Canvas,
            canvas::{self, Event, Frame, Geometry, LineCap, Path, Stroke, Text, path::Arc},
        },
    },
};

use crate::{palette, type_size};

const START_ANGLE: f32 = std::f32::consts::PI * 0.75;
const END_ANGLE: f32 = std::f32::consts::PI * 2.25;
const DRAG_SENSITIVITY: f32 = 200.0;

/// Create a parameter knob whose drawing is sourced from YADAW semantic tokens.
pub fn parameter_knob<M: Clone + Debug + 'static>(
    id: impl Into<u32>,
    params: &ParamCache<impl Params>,
) -> ParameterKnob<'_, M> {
    ParameterKnob::new(id.into(), params)
}

/// Create a fixed-dark built-in plug-in meter using YADAW signal colors.
pub fn level_meter<'a, M: Clone + Debug + 'static>(
    ids: &[impl Into<u32> + Copy],
    params: &'a ParamCache<impl Params>,
) -> LevelMeter<'a, M> {
    let ids = ids.iter().map(|id| (*id).into()).collect::<Vec<_>>();
    LevelMeter::new(&ids, params)
}

pub struct ParameterKnob<'a, M> {
    id: u32,
    value: f64,
    display: String,
    label: Option<&'a str>,
    size: f32,
    font: Font,
    marker: PhantomData<M>,
}

impl<'a, M: Clone + Debug + 'static> ParameterKnob<'a, M> {
    fn new(id: u32, params: &'a ParamCache<impl Params>) -> Self {
        Self {
            id,
            value: params.get(id),
            display: params.label(id).to_owned(),
            label: None,
            size: 64.0,
            font: params.font(),
            marker: PhantomData,
        }
    }

    #[must_use]
    pub fn label(mut self, label: &'a str) -> Self {
        self.label = Some(label);
        self
    }

    #[must_use]
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    #[must_use]
    pub fn font(mut self, font: Font) -> Self {
        self.font = font;
        self
    }

    #[must_use]
    pub fn into_element(self) -> Element<'a, Message<M>> {
        Canvas::new(KnobProgram {
            id: self.id,
            value: f32::from_f64(self.value),
            display: self.display,
            label: self.label.unwrap_or_default().to_owned(),
            font: self.font,
        })
        .width(Length::Fixed(self.size))
        .height(Length::Fixed(self.size + 24.0))
        .into()
    }
}

impl<'a, M: Clone + Debug + 'static> From<ParameterKnob<'a, M>> for Element<'a, Message<M>> {
    fn from(knob: ParameterKnob<'a, M>) -> Self {
        knob.into_element()
    }
}

struct KnobProgram {
    id: u32,
    value: f32,
    display: String,
    label: String,
    font: Font,
}

#[derive(Default)]
struct KnobState {
    dragging: bool,
    start_value: f32,
    start_y: f32,
}

impl<M: Clone + Debug + 'static> canvas::Program<Message<M>> for KnobProgram {
    type State = KnobState;

    fn draw(
        &self,
        state: &Self::State,
        renderer: &Renderer,
        _theme: &Theme,
        bounds: Rectangle,
        cursor: mouse::Cursor,
    ) -> Vec<Geometry> {
        let colors = palette();
        let mut frame = Frame::new(renderer, bounds.size());
        let center = Point::new(bounds.width / 2.0, bounds.width / 2.0);
        let radius = (bounds.width / 2.0 - 6.0).max(8.0);
        let hovered = state.dragging
            || cursor.position_in(bounds).is_some_and(|position| {
                let delta = position - center;
                (delta.x * delta.x + delta.y * delta.y).sqrt() <= radius + 5.0
            });

        let arc = |radius, end_angle| {
            Path::new(|builder| {
                builder.arc(Arc {
                    center,
                    radius,
                    start_angle: truce_iced::iced::Radians(START_ANGLE),
                    end_angle: truce_iced::iced::Radians(end_angle),
                });
            })
        };
        if hovered {
            frame.stroke(
                &arc(radius + 3.0, END_ANGLE),
                Stroke::default()
                    .with_color(colors.focus)
                    .with_width(1.5)
                    .with_line_cap(LineCap::Round),
            );
        }
        frame.stroke(
            &arc(radius, END_ANGLE),
            Stroke::default()
                .with_color(colors.control)
                .with_width(4.0)
                .with_line_cap(LineCap::Round),
        );
        let value_angle = START_ANGLE + self.value * (END_ANGLE - START_ANGLE);
        if self.value > 0.001 {
            frame.stroke(
                &arc(radius, value_angle),
                Stroke::default()
                    .with_color(colors.action)
                    .with_width(4.0)
                    .with_line_cap(LineCap::Round),
            );
        }
        let pointer = Path::line(
            center,
            Point::new(
                center.x + radius * 0.62 * value_angle.cos(),
                center.y + radius * 0.62 * value_angle.sin(),
            ),
        );
        frame.stroke(
            &pointer,
            Stroke::default().with_color(colors.text).with_width(2.0),
        );

        let value_y = bounds.width - 2.0;
        frame.fill_text(Text {
            content: self.display.clone(),
            position: Point::new(center.x, value_y),
            color: colors.text,
            size: Pixels(type_size::CAPTION),
            align_x: alignment::Horizontal::Center.into(),
            align_y: alignment::Vertical::Top,
            font: self.font,
            ..Text::default()
        });
        if !self.label.is_empty() {
            frame.fill_text(Text {
                content: self.label.clone(),
                position: Point::new(center.x, value_y + 12.0),
                color: colors.text_muted,
                size: Pixels(type_size::CAPTION),
                align_x: alignment::Horizontal::Center.into(),
                align_y: alignment::Vertical::Top,
                font: self.font,
                ..Text::default()
            });
        }
        vec![frame.into_geometry()]
    }

    fn update(
        &self,
        state: &mut Self::State,
        event: &Event,
        bounds: Rectangle,
        cursor: mouse::Cursor,
    ) -> Option<canvas::Action<Message<M>>> {
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
                if cursor.position_in(bounds).is_some() =>
            {
                state.dragging = true;
                state.start_value = self.value;
                state.start_y = cursor.position_in(bounds)?.y;
                Some(
                    canvas::Action::publish(Message::Param(ParamMessage::BeginEdit(self.id)))
                        .and_capture(),
                )
            }
            Event::Mouse(mouse::Event::CursorMoved { .. }) if state.dragging => {
                let position = cursor.position()?;
                let delta = (state.start_y - (position.y - bounds.y)) / DRAG_SENSITIVITY;
                let value = (state.start_value + delta).clamp(0.0, 1.0);
                Some(
                    canvas::Action::publish(Message::Param(ParamMessage::SetNormalized(
                        self.id,
                        f64::from(value),
                    )))
                    .and_capture(),
                )
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) if state.dragging => {
                state.dragging = false;
                Some(
                    canvas::Action::publish(Message::Param(ParamMessage::EndEdit(self.id)))
                        .and_capture(),
                )
            }
            _ => None,
        }
    }

    fn mouse_interaction(
        &self,
        state: &Self::State,
        bounds: Rectangle,
        cursor: mouse::Cursor,
    ) -> mouse::Interaction {
        if state.dragging {
            mouse::Interaction::Grabbing
        } else if cursor.position_in(bounds).is_some() {
            mouse::Interaction::Grab
        } else {
            mouse::Interaction::default()
        }
    }
}

pub struct LevelMeter<'a, M> {
    values: Vec<f32>,
    width: Length,
    height: Length,
    marker: PhantomData<(&'a (), M)>,
}

impl<'a, M: Clone + Debug + 'static> LevelMeter<'a, M> {
    fn new(ids: &[u32], params: &'a ParamCache<impl Params>) -> Self {
        Self {
            values: ids.iter().map(|id| params.meter(*id)).collect(),
            width: Length::Fixed(16.0),
            height: Length::Fixed(80.0),
            marker: PhantomData,
        }
    }

    #[must_use]
    pub fn size(mut self, width: f32, height: f32) -> Self {
        self.width = Length::Fixed(width);
        self.height = Length::Fixed(height);
        self
    }

    #[must_use]
    pub fn width(mut self, width: Length) -> Self {
        self.width = width;
        self
    }

    #[must_use]
    pub fn height(mut self, height: Length) -> Self {
        self.height = height;
        self
    }

    #[must_use]
    pub fn fill(mut self) -> Self {
        self.height = Length::Fill;
        self
    }

    #[must_use]
    pub fn into_element(self) -> Element<'a, Message<M>> {
        Canvas::new(MeterProgram {
            values: self.values,
        })
        .width(self.width)
        .height(self.height)
        .into()
    }
}

impl<'a, M: Clone + Debug + 'static> From<LevelMeter<'a, M>> for Element<'a, Message<M>> {
    fn from(meter: LevelMeter<'a, M>) -> Self {
        meter.into_element()
    }
}

struct MeterProgram {
    values: Vec<f32>,
}

impl<M: Clone + Debug + 'static> canvas::Program<Message<M>> for MeterProgram {
    type State = ();

    #[allow(clippy::cast_precision_loss)]
    fn draw(
        &self,
        _state: &Self::State,
        renderer: &Renderer,
        _theme: &Theme,
        bounds: Rectangle,
        _cursor: mouse::Cursor,
    ) -> Vec<Geometry> {
        let colors = palette();
        let mut frame = Frame::new(renderer, bounds.size());
        let channels = self.values.len().max(1);
        let gap = 2.0;
        let width =
            ((bounds.width - gap * channels.saturating_sub(1) as f32) / channels as f32).max(4.0);
        for (index, value) in self.values.iter().copied().enumerate() {
            let x = index as f32 * (width + gap);
            let background = Path::rectangle(Point::new(x, 0.0), Size::new(width, bounds.height));
            frame.fill(&background, colors.control);
            let display = meter_display(value);
            let fill_height = (display * bounds.height).clamp(0.0, bounds.height);
            if fill_height > 0.0 {
                let bar = Path::rectangle(
                    Point::new(x, bounds.height - fill_height),
                    Size::new(width, fill_height),
                );
                frame.fill(
                    &bar,
                    if display > 0.95 {
                        colors.danger
                    } else {
                        colors.audio
                    },
                );
            }
        }
        vec![frame.into_geometry()]
    }
}
