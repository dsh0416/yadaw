#[cfg(feature = "bench-internals")]
#[doc(hidden)]
pub mod bench_support {
    use std::{hint::black_box, sync::Arc, thread};

    use ringbuf::{
        HeapCons, HeapProd, HeapRb,
        traits::{Consumer, Producer, Split},
    };
    use yadaw_dsp_core::mixer::{ChannelKind, ChannelSpec, MixerGraph, RouteTarget, StereoFrame};
    use yadaw_dsp_render::{RenderMeter, RenderRuntime};
    use yadaw_dsp_runtime::{protocol::PluginAudioMode, tempo::TempoMap};

    use super::{
        AdaptiveResampler, ClipSamples, EngineCommand, InputPeakBank, LivePlugin, LoadedClip,
        MAX_PLUGIN_BLOCK_FRAMES, MeterAtomics, MeterBank, MetronomeScheduler, NativeMixerRuntime,
        ProcessContext, RealtimeParameter, RealtimeParameterCommand, SessionOutputConverter,
        SignalWidth, StereoDelayLine, StreamingClip, TRANSPORT_PLAYING, TransportShared,
        decode_clip_audio, spawn_streaming_clip,
    };

    #[derive(Clone, Copy, Debug)]
    pub struct RenderScenario {
        pub sample_rate: u32,
        pub tracks: usize,
        pub total_clips: usize,
        pub active_clips: usize,
        pub clip_frames: usize,
    }

    fn runtime_for(scenario: RenderScenario) -> Box<NativeMixerRuntime> {
        assert!(scenario.sample_rate > 0);
        assert!(scenario.tracks > 0);
        assert!(scenario.active_clips <= scenario.total_clips);
        let master = scenario.tracks;
        let output = master + 1;
        let mut channels = Vec::with_capacity(master + 2);
        for index in 0..scenario.tracks {
            channels.push(ChannelSpec {
                id: format!("audio-{index}"),
                kind: ChannelKind::Audio,
                gain_db: -3.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output: Some(RouteTarget::Output(output)),
                input_bus: None,
                hardware_output: None,
            });
        }
        channels.push(ChannelSpec {
            id: "master".to_owned(),
            kind: ChannelKind::Master,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: None,
            input_bus: None,
            hardware_output: None,
        });
        channels.push(ChannelSpec {
            id: "output".to_owned(),
            kind: ChannelKind::Output,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: None,
            input_bus: None,
            hardware_output: Some([0, 1]),
        });
        let graph = MixerGraph::new(scenario.sample_rate, channels, Vec::new())
            .expect("benchmark graph must be valid");
        let mut graph = RenderRuntime::from_mixer_graph(
            scenario.sample_rate,
            graph,
            TempoMap::default_120_bpm(),
        );
        graph.prepare_block_processing(MAX_PLUGIN_BLOCK_FRAMES);
        let meter_bank = Arc::new(MeterBank {
            channels: (0..scenario.tracks + 2)
                .map(|index| MeterAtomics::new(format!("channel-{index}")))
                .collect(),
        });
        let transport = Arc::new(TransportShared {
            state: Arc::new(super::AtomicU32::new(TRANSPORT_PLAYING)),
            position_frames: Arc::new(super::AtomicU64::new(0)),
            position_ticks: Arc::new(super::AtomicU64::new(0)),
            sample_rate: super::AtomicU32::new(scenario.sample_rate),
            effective_bpm_bits: super::AtomicU64::new(f64::NAN.to_bits()),
            clock_source: super::AtomicU32::new(0),
            waiting_for: super::AtomicU32::new(0),
            loop_enabled: super::AtomicBool::new(false),
            loop_has_range: super::AtomicBool::new(false),
            loop_start_tick: super::AtomicU64::new(0),
            loop_end_tick: super::AtomicU64::new(0),
        });
        let input_peaks = Arc::new(InputPeakBank::new());
        let clip_frames = scenario.clip_frames.max(1);
        let clips = (0..scenario.total_clips)
            .map(|index| {
                let active = index < scenario.active_clips;
                LoadedClip {
                    channel_index: index % scenario.tracks,
                    start_frame: if active {
                        0
                    } else {
                        1_000_000_u64.saturating_add(index as u64)
                    },
                    source_offset_frames: 0,
                    length_frames: if active { clip_frames } else { 1 },
                    fade_in_frames: 0,
                    fade_out_frames: 0,
                    samples: ClipSamples::Memory(if active {
                        vec![[0.03125, -0.015625]; clip_frames]
                    } else {
                        vec![[0.0, 0.0]]
                    }),
                }
            })
            .collect();
        Box::new(NativeMixerRuntime {
            generation: 1,
            build_generation: 1,
            peak_scratch: vec![
                RenderMeter {
                    pre: [0.0; 2],
                    post: [0.0; 2],
                };
                graph.channel_count()
            ],
            held_peaks: vec![[0.0, 0.0]; graph.channel_count()],
            held_until: vec![[0, 0]; graph.channel_count()],
            channel_source_block: vec![
                [0.0, 0.0];
                (scenario.tracks + 2).saturating_mul(MAX_PLUGIN_BLOCK_FRAMES)
            ],
            channel_input_widths: vec![SignalWidth::Stereo; scenario.tracks + 2],
            plugins_by_channel: (0..scenario.tracks + 2).map(|_| Vec::new()).collect(),
            midi_events: Vec::new(),
            midi_event_data: Vec::new(),
            midi_cursor: 0,
            active_notes: Vec::new(),
            live_midi_routes: vec![None; scenario.tracks + 2],
            live_midi_events: Vec::new(),
            live_notes: vec![false; (scenario.tracks + 2) * 16 * 128],
            external_sync_enabled: false,
            live_sysex_scratch: vec![0; yadaw_dsp_runtime::midi_input::MIDI_MAX_SYSEX_BYTES],
            metronome: MetronomeScheduler::new(
                None,
                &TempoMap::default_120_bpm(),
                scenario.sample_rate,
                0,
            ),
            count_in: None,
            tempo_map: TempoMap::default_120_bpm(),
            graph,
            clips,
            meter_bank,
            transport,
            sample_rate: scenario.sample_rate,
            content_end_frame: u64::MAX,
            tail_end_frame: Some(u64::MAX),
            has_infinite_tail: false,
            input_peaks,
            input_meter_routes: vec![None; scenario.tracks + 2],
            monitor_input_routes: vec![None; scenario.tracks + 2],
            input_peak_scratch: [0.0; super::MAX_INPUT_CHANNELS],
            meter_frame_clock: 0,
        })
    }

    pub struct RenderHarness {
        runtime: Box<NativeMixerRuntime>,
        inputs: Vec<super::InputFrame>,
        outputs: Vec<super::HardwareOutputFrame>,
    }

    impl RenderHarness {
        pub fn new(scenario: RenderScenario) -> Self {
            Self {
                runtime: runtime_for(scenario),
                inputs: vec![[0.0; super::MAX_INPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES],
                outputs: vec![[0.0; super::MAX_OUTPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES],
            }
        }

        pub fn render_block(&mut self, frames: usize) -> StereoFrame {
            self.runtime
                .transport
                .position_frames
                .store(0, super::Ordering::Relaxed);
            let mut output = [0.0, 0.0];
            let mut rendered = 0;
            while rendered < frames {
                let block_frames = (frames - rendered).min(MAX_PLUGIN_BLOCK_FRAMES);
                let underrun = self.runtime.render_block(
                    &self.inputs[..block_frames],
                    &mut self.outputs[..block_frames],
                    None,
                );
                debug_assert!(!underrun);
                let frame = self.outputs[block_frames - 1];
                output = [frame[0], frame[1]];
                rendered += block_frames;
            }
            output
        }

        pub fn enable_stopped_monitoring(&mut self) {
            self.runtime.monitor_input_routes[0] = Some([0, 1]);
            self.runtime
                .transport
                .state
                .store(super::TRANSPORT_STOPPED, super::Ordering::Relaxed);
        }

        pub fn render_monitoring_block(
            &mut self,
            frames: usize,
            input: StereoFrame,
        ) -> StereoFrame {
            let mut output = [0.0, 0.0];
            let mut rendered = 0;
            while rendered < frames {
                let block_frames = (frames - rendered).min(MAX_PLUGIN_BLOCK_FRAMES);
                for input_frame in &mut self.inputs[..block_frames] {
                    input_frame[..2].copy_from_slice(&input);
                }
                let underrun = self.runtime.render_block(
                    &self.inputs[..block_frames],
                    &mut self.outputs[..block_frames],
                    None,
                );
                debug_assert!(!underrun);
                let frame = self.outputs[block_frames - 1];
                output = [frame[0], frame[1]];
                rendered += block_frames;
            }
            output
        }

        pub fn publish_meters(&mut self, elapsed_frames: usize) {
            self.runtime.publish_peaks(elapsed_frames);
        }
    }

    pub struct PluginAdapterHarness {
        plugins: [LivePlugin; 4],
        context: ProcessContext,
    }

    impl PluginAdapterHarness {
        pub fn new() -> Self {
            Self {
                plugins: [
                    missing_effect(PluginAudioMode::Mono),
                    missing_effect(PluginAudioMode::DualMono),
                    missing_effect(PluginAudioMode::MonoToStereo),
                    missing_effect(PluginAudioMode::Stereo),
                ],
                context: ProcessContext {
                    project_time_samples: 0,
                    continuous_time_samples: 0,
                    project_time_quarters: 0.0,
                    bar_position_quarters: 0.0,
                    tempo: 120.0,
                    time_signature_numerator: 4,
                    time_signature_denominator: 4,
                    playing: false,
                    recording: false,
                },
            }
        }

        pub fn render_frame(&mut self, mut frame: StereoFrame) -> StereoFrame {
            let mut width = SignalWidth::Stereo;
            let mut frames = [frame];
            for plugin in &mut self.plugins {
                plugin.process_block(&mut frames, &mut width, &self.context, &[]);
            }
            frame = frames[0];
            match width {
                SignalWidth::Mono => [frame[0], frame[0]],
                SignalWidth::Stereo => frame,
            }
        }
    }

    impl Default for PluginAdapterHarness {
        fn default() -> Self {
            Self::new()
        }
    }

    fn missing_effect(audio_mode: PluginAudioMode) -> LivePlugin {
        LivePlugin {
            instance_id: "missing-effect".to_owned(),
            processor: None,
            audio_mode,
            enabled: false,
            is_instrument: false,
            latency_samples: 0,
            main_delay: StereoDelayLine::new(0),
            bypass_delay: StereoDelayLine::new(0),
            marker_index: 0,
            aux_inputs: Vec::new(),
        }
    }

    pub struct ParameterQueueHarness {
        runtime: Box<NativeMixerRuntime>,
        producer: HeapProd<EngineCommand>,
        consumer: HeapCons<EngineCommand>,
        command: RealtimeParameterCommand,
    }

    impl ParameterQueueHarness {
        pub fn new() -> Self {
            let ring = HeapRb::<EngineCommand>::new(8);
            let (producer, consumer) = ring.split();
            let mut id = [0_u8; 64];
            id[..7].copy_from_slice(b"audio-0");
            Self {
                runtime: runtime_for(RenderScenario {
                    sample_rate: 48_000,
                    tracks: 32,
                    total_clips: 32,
                    active_clips: 32,
                    clip_frames: 1_024,
                }),
                producer,
                consumer,
                command: RealtimeParameterCommand {
                    id,
                    id_len: 7,
                    parameter: RealtimeParameter::ChannelGain,
                    value: -6.0,
                },
            }
        }

        pub fn consume_preview(&mut self, value: f32) {
            self.command.value = value;
            assert!(
                self.producer
                    .try_push(EngineCommand::Preview(self.command))
                    .is_ok(),
                "benchmark control ring must have capacity"
            );
            let command = self
                .consumer
                .try_pop()
                .expect("benchmark command must be available");
            black_box(self.runtime.handle_command(command));
        }
    }

    impl Default for ParameterQueueHarness {
        fn default() -> Self {
            Self::new()
        }
    }

    pub struct GraphSwapHarness {
        current: Option<Box<NativeMixerRuntime>>,
        replacement: Option<Box<NativeMixerRuntime>>,
    }

    impl GraphSwapHarness {
        pub fn new(scenario: RenderScenario) -> Self {
            Self {
                current: Some(runtime_for(scenario)),
                replacement: Some(runtime_for(scenario)),
            }
        }

        pub fn swap_at_block_boundary(&mut self) {
            let mut current = self.current.take().expect("current graph");
            let replacement = self.replacement.take().expect("replacement graph");
            let incoming = current
                .handle_command(EngineCommand::LoadMixer(replacement))
                .expect("load command returns replacement");
            self.current = Some(incoming);
            self.replacement = Some(current);
        }
    }

    pub struct ResamplerHarness {
        resampler: AdaptiveResampler,
        output_frames: usize,
    }

    impl ResamplerHarness {
        pub fn new(input_rate: u32, output_rate: u32, output_frames: usize) -> Self {
            let source_frames = (output_frames as u128 * u128::from(input_rate))
                .div_ceil(u128::from(output_rate)) as usize
                + 1_024;
            let capacity = source_frames.next_power_of_two().max(8);
            let ring = HeapRb::<super::InputFrame>::new(capacity);
            let (mut producer, consumer) = ring.split();
            for index in 0..source_frames {
                let mut frame = [0.0; super::MAX_INPUT_CHANNELS];
                frame[0] = index as f32 / source_frames as f32;
                frame[1] = -frame[0];
                producer
                    .try_push(frame)
                    .expect("resampler fixture ring has capacity");
            }
            Self {
                resampler: AdaptiveResampler::new(
                    consumer,
                    input_rate,
                    output_rate,
                    2,
                    source_frames / 2,
                    capacity,
                )
                .expect("benchmark resampler must be valid"),
                output_frames,
            }
        }

        pub fn render(&mut self) -> StereoFrame {
            let mut output = [0.0, 0.0];
            for _ in 0..self.output_frames {
                let (frame, _underrun) = self.resampler.next_frame();
                output = [frame[0], frame[1]];
            }
            output
        }
    }

    pub struct SessionRateBridgeHarness {
        input_resampler: AdaptiveResampler,
        output_converter: SessionOutputConverter,
        device_outputs: Vec<super::HardwareOutputFrame>,
    }

    impl SessionRateBridgeHarness {
        pub fn new(input_rate: u32, session_rate: u32, output_rate: u32) -> Self {
            let source_frames = 16_384;
            let ring = HeapRb::<super::InputFrame>::new(source_frames);
            let (mut producer, consumer) = ring.split();
            for index in 0..source_frames {
                let mut frame = [0.0; super::MAX_INPUT_CHANNELS];
                frame[0] = index as f32 / source_frames as f32;
                frame[1] = -frame[0];
                producer
                    .try_push(frame)
                    .expect("rate bridge fixture ring has capacity");
            }
            Self {
                input_resampler: AdaptiveResampler::new(
                    consumer,
                    input_rate,
                    session_rate,
                    2,
                    source_frames / 2,
                    source_frames,
                )
                .expect("input/session resampler must be valid"),
                output_converter: SessionOutputConverter::new(session_rate, output_rate, 2)
                    .expect("session/output resampler must be valid"),
                device_outputs: vec![[0.0; super::MAX_OUTPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES],
            }
        }

        pub fn render_device_block(&mut self, output_frames: usize) -> StereoFrame {
            let Self {
                input_resampler,
                output_converter,
                device_outputs,
            } = self;
            let mut output = [0.0, 0.0];
            let mut rendered = 0;
            while rendered < output_frames {
                let block_frames = (output_frames - rendered).min(MAX_PLUGIN_BLOCK_FRAMES);
                let _ = output_converter.render_block(
                    &mut device_outputs[..block_frames],
                    |session_outputs| {
                        let mut underrun = false;
                        for session_output in session_outputs {
                            let (input, frame_underrun) = input_resampler.next_frame();
                            session_output[0] = input[0];
                            session_output[1] = input[1];
                            underrun |= frame_underrun;
                        }
                        underrun
                    },
                );
                let frame = device_outputs[block_frames - 1];
                output = [frame[0], frame[1]];
                rendered += block_frames;
            }
            output
        }
    }

    pub fn decode_clip(path: &str, target_sample_rate: u32) -> usize {
        decode_clip_audio(path, target_sample_rate)
            .expect("benchmark fixture must decode")
            .len()
    }

    pub struct StreamingHarness {
        clip: StreamingClip,
        block_frames: usize,
    }

    impl StreamingHarness {
        pub fn open(path: impl Into<String>, target_sample_rate: u32, block_frames: usize) -> Self {
            let (clip, _) =
                spawn_streaming_clip(path.into(), target_sample_rate, 0).expect("stream fixture");
            Self { clip, block_frames }
        }

        pub fn read_cached_block(&mut self) -> StereoFrame {
            self.clip.expected_frame = Some(0);
            let mut output = [0.0, 0.0];
            for frame in 0..self.block_frames {
                output = self
                    .clip
                    .sample_at(frame)
                    .expect("initial window is cached");
            }
            output
        }

        pub fn seek_and_refill(&mut self, frame: usize) -> StereoFrame {
            self.clip.expected_frame = None;
            loop {
                if let Some(sample) = self.clip.sample_at(frame) {
                    return sample;
                }
                self.clip.expected_frame = Some(frame);
                thread::yield_now();
            }
        }
    }
}
