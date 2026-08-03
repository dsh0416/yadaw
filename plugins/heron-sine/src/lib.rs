//! YADAW's built-in 16-voice sine instrument VST3.

use std::f32::consts::TAU;
use std::sync::Arc;

use heron_plugin_ui::parameter_knob;
use truce::prelude::*;
use truce_iced::iced::widget::{Column, Row, Space, container, text};
use truce_iced::iced::{Alignment, Element, Length, alignment};
use truce_iced::{IcedEditor, IcedPlugin, IntoElement, Message, ParamCache};

use SineParamsParamId as P;

const MAX_VOICES: usize = 16;

#[derive(Params)]
pub struct SineParams {
    #[param(
        name = "Output",
        range = "linear(-90, 0)",
        unit = "dB",
        default = -18
    )]
    pub output: FloatParam,
    #[param(name = "Attack", range = "linear(0.5, 100)", unit = "ms", default = 5)]
    pub attack: FloatParam,
    #[param(name = "Release", range = "linear(5, 2000)", unit = "ms", default = 80)]
    pub release: FloatParam,
    #[meter]
    pub active_voices: MeterSlot,
    #[meter]
    pub recent_pitch: MeterSlot,
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    releasing: bool,
    group: u8,
    channel: u8,
    note: u8,
    phase: f32,
    phase_step: f32,
    velocity: f32,
    envelope: f32,
    envelope_step: f32,
    age: u64,
}

impl Voice {
    #[allow(clippy::too_many_arguments)]
    fn start(
        &mut self,
        group: u8,
        channel: u8,
        note: u8,
        velocity: f32,
        attack_ms: f32,
        sample_rate: f32,
        age: u64,
    ) {
        let frequency = 440.0 * 2.0f32.powf((f32::from(note) - 69.0) / 12.0);
        let attack_samples = (attack_ms * 0.001 * sample_rate).max(1.0);
        *self = Self {
            active: true,
            releasing: false,
            group,
            channel,
            note,
            phase: 0.0,
            phase_step: frequency / sample_rate,
            velocity,
            envelope: 0.0,
            envelope_step: 1.0 / attack_samples,
            age,
        };
    }

    fn release(&mut self, release_ms: f32, sample_rate: f32) {
        if !self.active || self.releasing {
            return;
        }
        self.releasing = true;
        let release_samples = (release_ms * 0.001 * sample_rate).max(1.0);
        self.envelope_step = self.envelope / release_samples;
    }

    fn render(&mut self) -> f32 {
        if !self.active {
            return 0.0;
        }
        if self.releasing {
            self.envelope = (self.envelope - self.envelope_step).max(0.0);
            if self.envelope <= f32::EPSILON {
                self.active = false;
                return 0.0;
            }
        } else {
            self.envelope = (self.envelope + self.envelope_step).min(1.0);
        }
        let sample = (self.phase * TAU).sin() * self.velocity * self.envelope;
        self.phase += self.phase_step;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        sample
    }
}

/// Fixed-capacity, allocation-free oscillator state.
pub struct SineDspState {
    voices: [Voice; MAX_VOICES],
    sample_rate: f32,
    next_age: u64,
    recent_pitch: u8,
}

impl Default for SineDspState {
    fn default() -> Self {
        Self {
            voices: [Voice::default(); MAX_VOICES],
            sample_rate: 44_100.0,
            next_age: 0,
            recent_pitch: 69,
        }
    }
}

impl SineDspState {
    fn note_on(&mut self, params: &SineParams, group: u8, channel: u8, note: u8, velocity: f32) {
        let index = self
            .voices
            .iter()
            .position(|voice| !voice.active)
            .unwrap_or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by(|(_, left), (_, right)| {
                        left.envelope
                            .total_cmp(&right.envelope)
                            .then_with(|| left.age.cmp(&right.age))
                    })
                    .map_or(0, |(index, _)| index)
            });
        self.next_age = self.next_age.saturating_add(1);
        self.recent_pitch = note;
        self.voices[index].start(
            group,
            channel,
            note,
            velocity,
            params.attack.value(),
            self.sample_rate,
            self.next_age,
        );
    }

    fn note_off(&mut self, params: &SineParams, group: u8, channel: u8, note: u8) {
        // Truce's VST3 wrapper resolves host note-id into its original
        // channel/note pair before exposing EventBody, so the newest held
        // matching voice is the framework-level equivalent of note-id match.
        if let Some(voice) = self
            .voices
            .iter_mut()
            .filter(|voice| {
                voice.active
                    && !voice.releasing
                    && voice.group == group
                    && voice.channel == channel
                    && voice.note == note
            })
            .max_by_key(|voice| voice.age)
        {
            voice.release(params.release.value(), self.sample_rate);
        }
    }

    fn active_voice_count(&self) -> usize {
        self.voices.iter().filter(|voice| voice.active).count()
    }
}

pub struct SineUi;

#[derive(Clone, Debug)]
pub enum SineMessage {}

impl IcedPlugin<SineParams> for SineUi {
    type Message = SineMessage;

    fn new(_params: Arc<SineParams>) -> Self {
        Self
    }

    fn view<'a>(
        &'a self,
        params: &'a ParamCache<SineParams>,
    ) -> Element<'a, Message<Self::Message>> {
        let palette = heron_plugin_ui::palette();
        let voices = (params.meter(P::ActiveVoices) * MAX_VOICES as f32).round() as u8;
        let pitch = (params.meter(P::RecentPitch) * 127.0).round() as u8;
        let header = Row::new()
            .push(
                text("YADAW  /  SINE")
                    .size(heron_plugin_ui::type_size::PANEL_TITLE)
                    .color(palette.text),
            )
            .push(Space::new().width(Length::Fill))
            .push(
                text(format!("{voices:02} VOICES   MIDI {pitch:03}"))
                    .size(heron_plugin_ui::type_size::BODY_COMPACT)
                    .color(palette.midi),
            );
        let trace = container(
            text("∿      ∿      ∿      ∿      ∿")
                .size(38)
                .color(palette.midi),
        )
        .width(Length::Fill)
        .height(Length::Fixed(92.0))
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
                    .size(76.0)
                    .el(),
            )
            .push(
                parameter_knob(P::Attack, params)
                    .label("ATTACK")
                    .size(76.0)
                    .el(),
            )
            .push(
                parameter_knob(P::Release, params)
                    .label("RELEASE")
                    .size(76.0)
                    .el(),
            )
            .spacing(heron_plugin_ui::space::XL)
            .align_y(alignment::Vertical::Center);
        container(
            Column::new()
                .push(header)
                .push(trace)
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
        String::from("YADAW Sine")
    }

    fn theme(&self) -> truce_iced::iced::Theme {
        heron_plugin_ui::theme()
    }
}

pub struct HeronSine;

impl PluginLogic for HeronSine {
    type Params = SineParams;
    type DspState = SineDspState;

    fn bus_layouts() -> Vec<BusLayout> {
        BusLayout::stereo_and_mono_output()
    }

    fn reset(state: &mut SineDspState, _params: &SineParams, config: &AudioConfig) {
        state.voices.fill(Voice::default());
        state.sample_rate = config.sample_rate as f32;
        state.next_age = 0;
    }

    fn tail(state: &SineDspState) -> u32 {
        (state.sample_rate * 2.0).round() as u32
    }

    fn process(
        state: &mut Self::DspState,
        params: &Self::Params,
        buffer: &mut AudioBuffer,
        events: &EventList,
        context: &mut ProcessContext,
    ) -> ProcessStatus {
        let mut next_event = 0;
        let channel_count = buffer.num_output_channels();
        for sample_index in 0..buffer.num_samples() {
            while let Some(event) = events.get(next_event) {
                if event.sample_offset as usize > sample_index {
                    break;
                }
                match event.body {
                    EventBody::NoteOn {
                        group,
                        channel,
                        note,
                        velocity,
                    } => state.note_on(params, group, channel, note, f32::from(velocity) / 127.0),
                    EventBody::NoteOff {
                        group,
                        channel,
                        note,
                        ..
                    } => state.note_off(params, group, channel, note),
                    EventBody::NoteOn2 {
                        group,
                        channel,
                        note,
                        velocity,
                        ..
                    } => {
                        state.note_on(params, group, channel, note, f32::from(velocity) / 65_535.0)
                    }
                    EventBody::NoteOff2 {
                        group,
                        channel,
                        note,
                        ..
                    } => state.note_off(params, group, channel, note),
                    _ => {}
                }
                next_event += 1;
            }
            let mut sample = 0.0;
            for voice in &mut state.voices {
                sample += voice.render();
            }
            let output_db = params.output.read();
            let output_gain = if output_db <= -90.0 {
                0.0
            } else {
                db_to_linear(output_db)
            };
            let output = sample * output_gain;
            if channel_count > 0 {
                buffer.output(0)[sample_index] = output;
            }
            if channel_count > 1 {
                buffer.output(1)[sample_index] = output;
            }
        }
        context.set_meter(
            P::ActiveVoices,
            state.active_voice_count() as f32 / MAX_VOICES as f32,
        );
        context.set_meter(P::RecentPitch, f32::from(state.recent_pitch) / 127.0);
        if state.active_voice_count() == 0 {
            ProcessStatus::Tail(0)
        } else {
            ProcessStatus::Normal
        }
    }

    fn editor(params: Arc<SineParams>) -> Box<dyn Editor> {
        IcedEditor::<SineParams, SineUi>::new(params, heron_plugin_ui::SINE_EDITOR_SIZE)
            .with_meter_ids(vec![P::ActiveVoices, P::RecentPitch])
            .into_editor()
    }
}

truce::plugin! {
    logic: HeronSine,
    params: SineParams,
}

truce::enable_rt_paranoid!();

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use truce_test::{assert_no_audio_alloc, assertions, driver};

    #[test]
    fn info_state_and_editor_are_valid() {
        truce_test::assert_valid_info::<Plugin>();
        truce_test::assert_has_editor::<Plugin>();
        truce_test::assert_state_round_trip::<Plugin>();
    }

    #[test]
    fn exposes_mono_and_stereo_instrument_outputs() {
        let channels = HeronSine::bus_layouts()
            .into_iter()
            .map(|layout| layout.total_output_channels())
            .collect::<Vec<_>>();
        assert_eq!(channels, vec![2, 1]);
    }

    #[test]
    fn silence_without_midi_and_finite_with_a4() {
        let silence = driver!(Plugin).duration(Duration::from_millis(12)).run();
        assertions::assert_silence(&silence);
        let sounding = driver!(Plugin)
            .duration(Duration::from_millis(50))
            .script(|script| {
                script.note_on(69, 1.0);
                script.wait_ms(30);
                script.note_off(69);
            })
            .run();
        assertions::assert_nonzero(&sounding);
        assertions::assert_no_nans(&sounding);
        assert_eq!(sounding.output[0], sounding.output[1]);
    }

    #[test]
    fn sixteen_voice_overflow_is_allocation_free() {
        assert_no_audio_alloc(|| {
            driver!(Plugin)
                .duration(Duration::from_millis(30))
                .script(|script| {
                    for note in 48..72 {
                        script.note_on(note, 0.8);
                    }
                    script.wait_ms(20);
                })
                .run()
        });
    }
}
