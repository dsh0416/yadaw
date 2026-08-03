//! Heron's built-in sample-accurate metronome instrument VST3.

use std::f32::consts::TAU;
use std::sync::Arc;

use heron_plugin_ui::parameter_knob;
use truce::prelude::*;
use truce_iced::iced::widget::{Column, Row, Space, container, text};
use truce_iced::iced::{Alignment, Element, Length, alignment};
use truce_iced::{IcedEditor, IcedPlugin, IntoElement, Message, ParamCache};

use MetronomeParamsParamId as P;

const MAX_VOICES: usize = 16;
const ACCENT_NOTE: u8 = 84;
const SILENCE_THRESHOLD: f32 = 0.001;

#[derive(Params)]
pub struct MetronomeParams {
    #[param(
        name = "Output",
        range = "linear(-90, 0)",
        unit = "dB",
        default = -12
    )]
    pub output: FloatParam,
    #[param(
        name = "Accent Tone",
        range = "linear(400, 4000)",
        unit = "Hz",
        default = 1600
    )]
    pub accent_tone: FloatParam,
    #[param(
        name = "Beat Tone",
        range = "linear(400, 4000)",
        unit = "Hz",
        default = 1000
    )]
    pub beat_tone: FloatParam,
    #[param(name = "Decay", range = "linear(10, 200)", unit = "ms", default = 40)]
    pub decay: FloatParam,
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    phase: f32,
    phase_step: f32,
    amplitude: f32,
    decay_coefficient: f32,
    age: u64,
}

impl Voice {
    fn start(&mut self, frequency: f32, velocity: f32, decay_ms: f32, sample_rate: f32, age: u64) {
        let decay_samples = (decay_ms * 0.001 * sample_rate).max(1.0);
        *self = Self {
            active: true,
            phase: 0.0,
            phase_step: frequency / sample_rate,
            amplitude: velocity,
            decay_coefficient: SILENCE_THRESHOLD.powf(1.0 / decay_samples),
            age,
        };
    }

    fn render(&mut self) -> f32 {
        if !self.active {
            return 0.0;
        }
        let sample = (self.phase * TAU).sin() * self.amplitude;
        self.phase += self.phase_step;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        self.amplitude *= self.decay_coefficient;
        if self.amplitude <= SILENCE_THRESHOLD {
            self.active = false;
        }
        sample
    }
}

/// Fixed-capacity, allocation-free one-shot click synthesizer state.
pub struct MetronomeDspState {
    voices: [Voice; MAX_VOICES],
    sample_rate: f32,
    next_age: u64,
}

impl Default for MetronomeDspState {
    fn default() -> Self {
        Self {
            voices: [Voice::default(); MAX_VOICES],
            sample_rate: 44_100.0,
            next_age: 0,
        }
    }
}

impl MetronomeDspState {
    fn note_on(&mut self, params: &MetronomeParams, note: u8, velocity: f32) {
        let index = self
            .voices
            .iter()
            .position(|voice| !voice.active)
            .unwrap_or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, voice)| voice.age)
                    .map_or(0, |(index, _)| index)
            });
        self.next_age = self.next_age.saturating_add(1);
        let frequency = if note == ACCENT_NOTE {
            params.accent_tone.value()
        } else {
            params.beat_tone.value()
        };
        self.voices[index].start(
            frequency,
            velocity,
            params.decay.value(),
            self.sample_rate,
            self.next_age,
        );
    }

    fn active_voice_count(&self) -> usize {
        self.voices.iter().filter(|voice| voice.active).count()
    }
}

pub struct MetronomeUi;

#[derive(Clone, Debug)]
pub enum MetronomeMessage {}

impl IcedPlugin<MetronomeParams> for MetronomeUi {
    type Message = MetronomeMessage;

    fn new(_params: Arc<MetronomeParams>) -> Self {
        Self
    }

    fn view<'a>(
        &'a self,
        params: &'a ParamCache<MetronomeParams>,
    ) -> Element<'a, Message<Self::Message>> {
        let palette = heron_plugin_ui::palette();
        let header = Row::new()
            .push(
                text("Heron  /  METRONOME")
                    .size(heron_plugin_ui::type_size::PANEL_TITLE)
                    .color(palette.text),
            )
            .push(Space::new().width(Length::Fill))
            .push(
                text("C6  ACCENT   ·   C5  BEAT")
                    .size(heron_plugin_ui::type_size::CONTROL)
                    .color(palette.midi),
            );
        let pulse = container(text("●     ·     ·     ·").size(34).color(palette.midi))
            .width(Length::Fill)
            .height(Length::Fixed(86.0))
            .align_x(Alignment::Center)
            .align_y(Alignment::Center)
            .style(move |_| container::Style {
                background: Some(palette.surface.into()),
                ..Default::default()
            });
        let controls = Row::new()
            .push(
                parameter_knob(P::Output, params)
                    .label("OUTPUT")
                    .size(72.0)
                    .el(),
            )
            .push(
                parameter_knob(P::AccentTone, params)
                    .label("ACCENT")
                    .size(72.0)
                    .el(),
            )
            .push(
                parameter_knob(P::BeatTone, params)
                    .label("BEAT")
                    .size(72.0)
                    .el(),
            )
            .push(
                parameter_knob(P::Decay, params)
                    .label("DECAY")
                    .size(72.0)
                    .el(),
            )
            .spacing(heron_plugin_ui::space::XL)
            .align_y(alignment::Vertical::Center);
        container(
            Column::new()
                .push(header)
                .push(pulse)
                .push(controls)
                .spacing(heron_plugin_ui::space::LG)
                .align_x(Alignment::Center),
        )
        .padding(heron_plugin_ui::space::XL)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(move |_| container::Style {
            background: Some(palette.canvas.into()),
            text_color: Some(palette.text),
            ..Default::default()
        })
        .into()
    }

    fn title(&self) -> String {
        String::from("Heron Metronome")
    }

    fn theme(&self) -> truce_iced::iced::Theme {
        heron_plugin_ui::theme()
    }
}

pub struct HeronMetronome;

impl PluginLogic for HeronMetronome {
    type Params = MetronomeParams;
    type DspState = MetronomeDspState;

    fn bus_layouts() -> Vec<BusLayout> {
        BusLayout::stereo_and_mono_output()
    }

    fn reset(state: &mut MetronomeDspState, _params: &MetronomeParams, config: &AudioConfig) {
        state.voices.fill(Voice::default());
        state.sample_rate = config.sample_rate as f32;
        state.next_age = 0;
    }

    fn tail(state: &MetronomeDspState) -> u32 {
        (state.sample_rate * 0.2).round() as u32
    }

    fn process(
        state: &mut Self::DspState,
        params: &Self::Params,
        buffer: &mut AudioBuffer,
        events: &EventList,
        _context: &mut ProcessContext,
    ) -> ProcessStatus {
        let mut next_event = 0;
        let channel_count = buffer.num_output_channels();
        for sample_index in 0..buffer.num_samples() {
            while let Some(event) = events.get(next_event) {
                if event.sample_offset as usize > sample_index {
                    break;
                }
                match event.body {
                    EventBody::NoteOn { note, velocity, .. } => {
                        state.note_on(params, note, f32::from(velocity) / 127.0)
                    }
                    EventBody::NoteOn2 { note, velocity, .. } => {
                        state.note_on(params, note, f32::from(velocity) / 65_535.0)
                    }
                    _ => {}
                }
                next_event += 1;
            }
            let sample = state.voices.iter_mut().map(Voice::render).sum::<f32>();
            let output_db = params.output.read();
            let gain = if output_db <= -90.0 {
                0.0
            } else {
                db_to_linear(output_db)
            };
            let output = sample * gain;
            if channel_count > 0 {
                buffer.output(0)[sample_index] = output;
            }
            if channel_count > 1 {
                buffer.output(1)[sample_index] = output;
            }
        }
        if state.active_voice_count() == 0 {
            ProcessStatus::Tail(0)
        } else {
            ProcessStatus::Normal
        }
    }

    fn editor(params: Arc<MetronomeParams>) -> Box<dyn Editor> {
        IcedEditor::<MetronomeParams, MetronomeUi>::new(
            params,
            heron_plugin_ui::METRONOME_EDITOR_SIZE,
        )
        .into_editor()
    }
}

truce::plugin! {
    logic: HeronMetronome,
    params: MetronomeParams,
}

truce::enable_rt_paranoid!();

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use truce_test::{assert_no_audio_alloc, assertions, driver};

    fn zero_crossings(samples: &[f32]) -> usize {
        samples
            .windows(2)
            .filter(|pair| pair[0].is_sign_positive() != pair[1].is_sign_positive())
            .count()
    }

    #[test]
    fn info_state_and_editor_are_valid() {
        truce_test::assert_valid_info::<Plugin>();
        truce_test::assert_has_editor::<Plugin>();
        truce_test::assert_state_round_trip::<Plugin>();
    }

    #[test]
    fn accent_and_regular_clicks_are_finite_and_distinct() {
        let accent = driver!(Plugin)
            .duration(Duration::from_millis(80))
            .script(|script| script.note_on(ACCENT_NOTE, 1.0))
            .run();
        let beat = driver!(Plugin)
            .duration(Duration::from_millis(80))
            .script(|script| script.note_on(72, 1.0))
            .run();
        assertions::assert_nonzero(&accent);
        assertions::assert_nonzero(&beat);
        assertions::assert_no_nans(&accent);
        assertions::assert_no_nans(&beat);
        assert_ne!(accent.output[0], beat.output[0]);
        assert!(zero_crossings(&accent.output[0]) > zero_crossings(&beat.output[0]));
        assert_eq!(accent.output[0], accent.output[1]);
        assert_eq!(beat.output[0], beat.output[1]);
    }

    #[test]
    fn output_and_decay_parameters_take_effect() {
        let result = driver!(Plugin)
            .duration(Duration::from_millis(260))
            .script(|script| {
                script.set_param(P::Output, -6.0);
                script.set_param(P::BeatTone, 400.0);
                script.set_param(P::Decay, 10.0);
                script.note_on(72, 0.75);
                script.wait_ms(220);
            })
            .run();
        assertions::assert_nonzero(&result);
        assertions::assert_no_nans(&result);
        let tail = &result.output[0][result.output[0].len().saturating_sub(128)..];
        assert!(tail.iter().all(|sample| sample.abs() <= f32::EPSILON));
    }

    #[test]
    fn voice_overflow_is_allocation_free() {
        assert_no_audio_alloc(|| {
            driver!(Plugin)
                .duration(Duration::from_millis(40))
                .script(|script| {
                    for note in 48..80 {
                        script.note_on(note, 0.8);
                    }
                    script.wait_ms(30);
                })
                .run()
        });
    }
}
