//! YADAW's built-in stereo gain VST3.

use std::sync::Arc;

use truce::prelude::*;
use truce_iced::iced::widget::{Column, Row, container, text};
use truce_iced::iced::{Alignment, Color, Element, Length, alignment};
use truce_iced::{IcedEditor, IcedPlugin, IntoElement, Message, ParamCache, knob, meter};

use GainParamsParamId as P;

#[derive(Params)]
pub struct GainParams {
    #[param(
        name = "Gain",
        range = "linear(-90, 24)",
        unit = "dB",
        default = 0,
        smooth = "linear(10)"
    )]
    pub gain: FloatParam,
    #[meter]
    pub meter_left: MeterSlot,
    #[meter]
    pub meter_right: MeterSlot,
}

fn color(rgba: [u8; 4]) -> Color {
    Color::from_rgba8(rgba[0], rgba[1], rgba[2], f32::from(rgba[3]) / 255.0)
}

/// Fixed YADAW instrument-panel UI.
pub struct GainUi;

#[derive(Clone, Debug)]
pub enum GainMessage {}

impl IcedPlugin<GainParams> for GainUi {
    type Message = GainMessage;

    fn new(_params: Arc<GainParams>) -> Self {
        Self
    }

    fn view<'a>(
        &'a self,
        params: &'a ParamCache<GainParams>,
    ) -> Element<'a, Message<Self::Message>> {
        let title = text("YADAW  /  GAIN")
            .size(14)
            .color(color(yadaw_plugin_ui::TEXT));
        let value = text(params.label(P::Gain))
            .size(30)
            .color(color(yadaw_plugin_ui::AUDIO_ACCENT));
        let control = Column::new()
            .push(title)
            .push(value)
            .push(knob(P::Gain, params).label("GAIN").size(126.0).el())
            .spacing(12)
            .align_x(Alignment::Center);
        let meters = meter(&[P::MeterLeft, P::MeterRight], params)
            .size(34.0, 180.0)
            .el();
        let surface = Row::new()
            .push(control)
            .push(meters)
            .spacing(28)
            .align_y(alignment::Vertical::Center);
        container(surface)
            .padding(24)
            .width(Length::Fill)
            .height(Length::Fill)
            .align_x(Alignment::Center)
            .align_y(Alignment::Center)
            .style(|_| container::Style {
                background: Some(color(yadaw_plugin_ui::CANVAS).into()),
                text_color: Some(color(yadaw_plugin_ui::TEXT)),
                ..Default::default()
            })
            .into()
    }

    fn title(&self) -> String {
        String::from("YADAW Gain")
    }
}

/// Stateless gain processor.
pub struct YadawGain;

impl PurePluginLogic for YadawGain {
    type Params = GainParams;

    fn bus_layouts() -> Vec<BusLayout> {
        vec![
            BusLayout::stereo(),
            BusLayout::mono(),
            BusLayout::new()
                .with_input("Main", ChannelConfig::Mono)
                .with_output("Main", ChannelConfig::Stereo),
        ]
    }

    fn process(
        params: &Self::Params,
        buffer: &mut AudioBuffer,
        _events: &EventList,
        context: &mut ProcessContext,
    ) -> ProcessStatus {
        for sample_index in 0..buffer.num_samples() {
            let gain_db = params.gain.read();
            let gain = if gain_db <= -90.0 {
                0.0
            } else if gain_db.abs() <= f32::EPSILON {
                1.0
            } else {
                db_to_linear(gain_db)
            };
            for output_channel in 0..buffer.num_output_channels() {
                let input_channel = output_channel.min(buffer.num_input_channels() - 1);
                let input = buffer.input(input_channel)[sample_index];
                buffer.output(output_channel)[sample_index] = input * gain;
            }
        }
        if buffer.num_output_channels() > 0 {
            context.set_meter(P::MeterLeft, buffer.output_peak(0));
        }
        if buffer.num_output_channels() > 1 {
            context.set_meter(P::MeterRight, buffer.output_peak(1));
        }
        ProcessStatus::Normal
    }

    fn editor(params: Arc<GainParams>) -> Box<dyn Editor> {
        IcedEditor::<GainParams, GainUi>::new(params, yadaw_plugin_ui::GAIN_EDITOR_SIZE)
            .with_meter_ids(vec![P::MeterLeft, P::MeterRight])
            .into_editor()
    }
}

truce::plugin! {
    logic: YadawGain,
    params: GainParams,
}

truce::enable_rt_paranoid!();

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use truce_test::{InputSource, assert_no_audio_alloc, assertions, driver};

    #[test]
    fn info_state_and_editor_are_valid() {
        truce_test::assert_valid_info::<Plugin>();
        truce_test::assert_has_editor::<Plugin>();
        truce_test::assert_state_round_trip::<Plugin>();
    }

    #[test]
    fn exposes_mono_mono_to_stereo_and_stereo_layouts() {
        let layouts = <YadawGain as PurePluginLogic>::bus_layouts()
            .into_iter()
            .map(|layout| {
                (
                    layout.total_input_channels(),
                    layout.total_output_channels(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(layouts, vec![(2, 2), (1, 1), (1, 2)]);
    }

    #[test]
    fn zero_db_is_exact_stereo_passthrough() {
        let result = driver!(Plugin)
            .duration(Duration::from_millis(10))
            .input(InputSource::Constant(0.25))
            .run();
        for channel in &result.output {
            assert!(
                channel
                    .iter()
                    .all(|sample| sample.to_bits() == 0.25f32.to_bits())
            );
        }
    }

    #[test]
    fn gain_process_is_allocation_free_and_finite() {
        let result = assert_no_audio_alloc(|| {
            driver!(Plugin)
                .duration(Duration::from_millis(40))
                .input(InputSource::Constant(0.5))
                .script(|script| {
                    script.set_param(P::Gain, 6.0);
                    script.wait_ms(15);
                    script.set_param(P::Gain, -90.0);
                })
                .run()
        });
        assertions::assert_no_nans(&result);
    }
}
