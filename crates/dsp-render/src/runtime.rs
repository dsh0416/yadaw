use std::{error::Error, fmt};

use yadaw_dsp_core::mixer::{
    ChannelKind, ChannelPeak, ChannelSpec, GraphError, HardwareOutputFrame, MixerGraph,
    RouteTarget, SendSpec, SendTap, StereoFrame,
};
use yadaw_dsp_runtime::tempo::{TempoMap, TempoMapError};

use crate::{
    PluginProcessContext, PluginProcessor, RenderChannelKind, RenderClipSpec, RenderGraphSpec,
    RenderResources, RenderRoute, RenderSendTap, resources::AudioClipSource,
};

struct RuntimeClip {
    spec: RenderClipSpec,
    channel_index: usize,
    source: Box<dyn AudioClipSource>,
}

struct RuntimePlugin {
    id: String,
    processor: Box<dyn PluginProcessor>,
}

struct RuntimeMidi {
    plugin_index: usize,
    notes: Vec<crate::RenderMidiNote>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderTransport {
    Stopped,
    Playing,
    Recording,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RenderMeter {
    pub pre: StereoFrame,
    pub post: StereoFrame,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderDiagnosticSnapshot {
    pub sample_position: u64,
    pub channel_count: usize,
    pub clip_count: usize,
    pub plugin_count: usize,
    pub transport: RenderTransport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderBuildError {
    Mixer(GraphError),
    Tempo(TempoMapError),
    MissingChannel(String),
    MissingClipSource(String),
    MissingPluginProcessor(String),
    MissingPlugin(String),
}

impl fmt::Display for RenderBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mixer(error) => write!(formatter, "could not build mixer graph: {error}"),
            Self::Tempo(error) => write!(formatter, "could not build tempo map: {error}"),
            Self::MissingChannel(id) => write!(formatter, "render channel '{id}' was not found"),
            Self::MissingClipSource(id) => write!(formatter, "clip source '{id}' was not provided"),
            Self::MissingPluginProcessor(id) => {
                write!(formatter, "plugin processor '{id}' was not provided")
            }
            Self::MissingPlugin(id) => write!(formatter, "render plugin '{id}' was not found"),
        }
    }
}

impl Error for RenderBuildError {}

impl From<GraphError> for RenderBuildError {
    fn from(value: GraphError) -> Self {
        Self::Mixer(value)
    }
}

impl From<TempoMapError> for RenderBuildError {
    fn from(value: TempoMapError) -> Self {
        Self::Tempo(value)
    }
}

pub struct RenderRuntime {
    sample_rate: u32,
    mixer: MixerGraph,
    tempo_map: TempoMap,
    channel_sources: Vec<StereoFrame>,
    hardware_inputs: Vec<Option<[usize; 2]>>,
    clips: Vec<RuntimeClip>,
    plugins: Vec<RuntimePlugin>,
    plugins_by_channel: Vec<Vec<usize>>,
    midi: Vec<RuntimeMidi>,
    meters: Vec<ChannelPeak>,
    sample_position: u64,
    transport: RenderTransport,
}

impl RenderRuntime {
    /// Creates a render runtime around a host-prepared mixer graph.
    ///
    /// Hosts use this after decoding media, instantiating processors, and
    /// establishing latency compensation. Those host resources can then feed
    /// pre-rendered channel sources through [`Self::process_channel_sources`].
    #[must_use]
    pub fn from_mixer_graph(sample_rate: u32, mixer: MixerGraph, tempo_map: TempoMap) -> Self {
        let channel_count = mixer.channel_count();
        Self {
            sample_rate,
            mixer,
            tempo_map,
            channel_sources: vec![[0.0; 2]; channel_count],
            hardware_inputs: vec![None; channel_count],
            clips: Vec::new(),
            plugins: Vec::new(),
            plugins_by_channel: vec![Vec::new(); channel_count],
            midi: Vec::new(),
            meters: vec![ChannelPeak::default(); channel_count],
            sample_position: 0,
            transport: RenderTransport::Stopped,
        }
    }

    pub fn build(
        spec: RenderGraphSpec,
        mut resources: RenderResources,
    ) -> Result<Self, RenderBuildError> {
        let channel_index = |id: &str| {
            spec.channels
                .iter()
                .position(|channel| channel.id == id)
                .ok_or_else(|| RenderBuildError::MissingChannel(id.to_owned()))
        };
        let route = |value: &RenderRoute| -> Result<RouteTarget, RenderBuildError> {
            Ok(match value {
                RenderRoute::Channel(id) => RouteTarget::Output(channel_index(id)?),
                RenderRoute::Bus(index) => RouteTarget::Bus(*index),
            })
        };
        let channels = spec
            .channels
            .iter()
            .map(|channel| {
                Ok(ChannelSpec {
                    id: channel.id.clone(),
                    kind: match channel.kind {
                        RenderChannelKind::Audio => ChannelKind::Audio,
                        RenderChannelKind::Instrument => ChannelKind::Instrument,
                        RenderChannelKind::Aux => ChannelKind::Aux,
                        RenderChannelKind::Master => ChannelKind::Master,
                        RenderChannelKind::Output => ChannelKind::Output,
                    },
                    gain_db: channel.gain_db,
                    pan: channel.pan,
                    muted: channel.muted,
                    soloed: channel.soloed,
                    output: channel.output.as_ref().map(&route).transpose()?,
                    input_bus: channel.input_bus,
                    hardware_output: channel.hardware_output,
                })
            })
            .collect::<Result<Vec<_>, RenderBuildError>>()?;
        let sends = spec
            .sends
            .iter()
            .map(|send| {
                Ok(SendSpec {
                    id: send.id.clone(),
                    source: channel_index(&send.source_channel_id)?,
                    target: route(&send.target)?,
                    enabled: send.enabled,
                    tap: match send.tap {
                        RenderSendTap::Pre => SendTap::Pre,
                        RenderSendTap::Post => SendTap::Post,
                        RenderSendTap::PostPan => SendTap::PostPan,
                    },
                    level_db: send.level_db,
                })
            })
            .collect::<Result<Vec<_>, RenderBuildError>>()?;
        let mixer = MixerGraph::new(spec.sample_rate, channels, sends)?;
        let tempo_map = TempoMap::new(spec.tempo_events, spec.time_signature_events)?;
        let mut clips = Vec::with_capacity(spec.clips.len());
        for clip in spec.clips {
            let source_id = clip.source_id.clone();
            clips.push(RuntimeClip {
                channel_index: channel_index(&clip.channel_id)?,
                source: resources
                    .take_clip(&source_id)
                    .ok_or(RenderBuildError::MissingClipSource(source_id))?,
                spec: clip,
            });
        }
        let mut plugin_specs = spec.plugins;
        plugin_specs.sort_by_key(|plugin| plugin.slot_order);
        let mut plugins = Vec::with_capacity(plugin_specs.len());
        let mut plugins_by_channel = vec![Vec::new(); spec.channels.len()];
        for plugin in plugin_specs {
            if !plugin.enabled {
                continue;
            }
            let processor_id = plugin.processor_id.clone();
            let index = plugins.len();
            plugins.push(RuntimePlugin {
                id: plugin.id,
                processor: resources
                    .clone_plugin(&processor_id)
                    .ok_or(RenderBuildError::MissingPluginProcessor(processor_id))?,
            });
            plugins_by_channel[channel_index(&plugin.channel_id)?].push(index);
        }
        let mut midi = Vec::with_capacity(spec.midi.len());
        for value in spec.midi {
            let plugin_index = plugins
                .iter()
                .position(|plugin| plugin.id == value.plugin_id)
                .ok_or(RenderBuildError::MissingPlugin(value.plugin_id))?;
            midi.push(RuntimeMidi {
                plugin_index,
                notes: value.notes,
            });
        }
        let channel_count = mixer.channel_count();
        Ok(Self {
            sample_rate: spec.sample_rate,
            mixer,
            tempo_map,
            channel_sources: vec![[0.0; 2]; channel_count],
            hardware_inputs: spec
                .channels
                .iter()
                .map(|channel| channel.hardware_input)
                .collect(),
            clips,
            plugins,
            plugins_by_channel,
            midi,
            meters: vec![ChannelPeak::default(); channel_count],
            sample_position: 0,
            transport: RenderTransport::Stopped,
        })
    }

    pub fn set_transport(&mut self, transport: RenderTransport) {
        self.transport = transport;
    }

    #[must_use]
    pub fn transport(&self) -> RenderTransport {
        self.transport
    }

    pub fn seek(&mut self, sample_position: u64) {
        self.sample_position = sample_position;
        self.chase_notes();
    }

    pub fn preview_channel_gain(&mut self, channel: usize, gain_db: f32) -> Result<(), GraphError> {
        self.mixer.set_channel_gain(channel, gain_db)
    }

    pub fn preview_channel_pan(&mut self, channel: usize, pan: f32) -> Result<(), GraphError> {
        self.mixer.set_channel_pan(channel, pan)
    }

    pub fn preview_send_level(&mut self, send: usize, level_db: f32) -> Result<(), GraphError> {
        self.mixer.set_send_level(send, level_db)
    }

    pub fn preview_plugin_parameter(&mut self, plugin: usize, parameter_id: u32, normalized: f64) {
        if let Some(plugin) = self.plugins.get_mut(plugin) {
            plugin
                .processor
                .set_parameter(parameter_id, normalized.clamp(0.0, 1.0));
        }
    }

    #[must_use]
    pub fn channel_count(&self) -> usize {
        self.mixer.channel_count()
    }

    #[must_use]
    pub fn channel_index(&self, id: &str) -> Option<usize> {
        self.mixer.channel_index(id)
    }

    #[must_use]
    pub fn send_index(&self, id: &str) -> Option<usize> {
        self.mixer.send_index(id)
    }

    pub fn clear_delays(&mut self) {
        self.mixer.clear_delays();
    }

    /// Preallocates graph scratch for block processing before real-time publication.
    pub fn prepare_block_processing(&mut self, maximum_frames: usize) {
        self.mixer.prepare_block_processing(maximum_frames);
    }

    /// Routes host-prepared channel sources through the shared graph kernel.
    ///
    /// The callback runs inline on the caller's render thread and must obey the
    /// same no-I/O, no-lock, no-allocation contract as `render_frame`.
    pub fn process_channel_sources(
        &mut self,
        sources: &[StereoFrame],
        process: &mut impl FnMut(usize, StereoFrame) -> StereoFrame,
    ) -> HardwareOutputFrame {
        self.mixer.process_frame_with_sources(sources, process)
    }

    /// Routes host-prepared, channel-major source blocks through the graph.
    ///
    /// The processor callback is invoked once per channel with the entire
    /// contiguous block. Scratch must have been prepared with
    /// [`Self::prepare_block_processing`] before entering the real-time thread.
    pub fn process_channel_source_block(
        &mut self,
        sources: &mut [StereoFrame],
        output: &mut [HardwareOutputFrame],
        process: &mut impl FnMut(usize, &mut [StereoFrame]),
    ) -> Result<(), GraphError> {
        self.mixer
            .process_block_with_sources(sources, output, process)
    }

    pub fn render_frame(&mut self, hardware_input: &[f32]) -> HardwareOutputFrame {
        self.channel_sources.fill([0.0; 2]);
        for (index, channels) in self.hardware_inputs.iter().enumerate() {
            if let Some([left, right]) = channels {
                self.channel_sources[index] = [
                    hardware_input.get(*left).copied().unwrap_or(0.0),
                    hardware_input.get(*right).copied().unwrap_or(0.0),
                ];
            }
        }
        for clip in &self.clips {
            let Some(relative) = self.sample_position.checked_sub(clip.spec.start_frame) else {
                continue;
            };
            if relative >= clip.spec.length_frames {
                continue;
            }
            let source_frame = clip.spec.source_offset_frames.saturating_add(relative);
            if source_frame >= clip.source.frame_count() {
                continue;
            }
            let left = clip.source.sample(source_frame, 0);
            let right = if clip.source.channels() > 1 {
                clip.source.sample(source_frame, 1)
            } else {
                left
            };
            self.channel_sources[clip.channel_index][0] += left;
            self.channel_sources[clip.channel_index][1] += right;
        }
        self.dispatch_midi();
        let context = self.process_context();
        let plugins = &mut self.plugins;
        let plugins_by_channel = &self.plugins_by_channel;
        let output = self.mixer.process_frame_with_sources(
            &self.channel_sources,
            &mut |channel, mut frame| {
                for plugin in &plugins_by_channel[channel] {
                    frame = plugins[*plugin].processor.process_frame(frame, context);
                }
                frame
            },
        );
        if self.transport != RenderTransport::Stopped {
            self.sample_position = self.sample_position.saturating_add(1);
        }
        output
    }

    pub fn render_block(&mut self, hardware_input: &[f32], output: &mut [HardwareOutputFrame]) {
        for frame in output {
            *frame = self.render_frame(hardware_input);
        }
    }

    pub fn write_meters(&mut self, target: &mut [RenderMeter]) {
        self.mixer.write_peaks(&mut self.meters);
        for (target, peak) in target.iter_mut().zip(&self.meters) {
            *target = RenderMeter {
                pre: peak.pre,
                post: peak.post,
            };
        }
    }

    #[must_use]
    pub fn diagnostic_snapshot(&self) -> RenderDiagnosticSnapshot {
        RenderDiagnosticSnapshot {
            sample_position: self.sample_position,
            channel_count: self.channel_sources.len(),
            clip_count: self.clips.len(),
            plugin_count: self.plugins.len(),
            transport: self.transport,
        }
    }

    fn process_context(&self) -> PluginProcessContext {
        let tick = self
            .tempo_map
            .frame_to_tick(self.sample_position, self.sample_rate)
            .unwrap_or(0);
        let tempo = self
            .tempo_map
            .tempo_events()
            .iter()
            .rev()
            .find(|event| event.tick <= tick)
            .copied()
            .unwrap_or(self.tempo_map.tempo_events()[0]);
        let signature = self
            .tempo_map
            .time_signature_events()
            .iter()
            .rev()
            .find(|event| event.tick <= tick)
            .copied()
            .unwrap_or(self.tempo_map.time_signature_events()[0]);
        let quarter_position = tick as f64 / 960.0;
        let quarters_per_bar =
            f64::from(signature.numerator) * 4.0 / f64::from(signature.denominator);
        PluginProcessContext {
            sample_position: self.sample_position,
            quarter_position,
            bar_position: quarter_position / quarters_per_bar,
            tempo: tempo.beats_per_minute,
            time_signature_numerator: signature.numerator,
            time_signature_denominator: signature.denominator,
            playing: self.transport != RenderTransport::Stopped,
            recording: self.transport == RenderTransport::Recording,
        }
    }

    fn dispatch_midi(&mut self) {
        let tick = self
            .tempo_map
            .frame_to_tick(self.sample_position, self.sample_rate)
            .unwrap_or(0);
        for midi in &self.midi {
            for note in &midi.notes {
                if note.start_tick == tick {
                    self.plugins[midi.plugin_index].processor.note_on(
                        note.channel,
                        note.key,
                        note.velocity,
                    );
                }
                if note.start_tick.saturating_add(note.duration_ticks) == tick {
                    self.plugins[midi.plugin_index].processor.note_off(
                        note.channel,
                        note.key,
                        note.release_velocity,
                    );
                }
            }
        }
    }

    fn chase_notes(&mut self) {
        let tick = self
            .tempo_map
            .frame_to_tick(self.sample_position, self.sample_rate)
            .unwrap_or(0);
        for midi in &self.midi {
            for note in &midi.notes {
                let end = note.start_tick.saturating_add(note.duration_ticks);
                if note.start_tick <= tick && tick < end {
                    self.plugins[midi.plugin_index].processor.note_on(
                        note.channel,
                        note.key,
                        note.velocity,
                    );
                } else {
                    self.plugins[midi.plugin_index].processor.note_off(
                        note.channel,
                        note.key,
                        note.release_velocity,
                    );
                }
            }
        }
    }
}
