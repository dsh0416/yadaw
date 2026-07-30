#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::Arc,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use super::{
        AdaptiveResampler, AtomicU32, AtomicU64, AudioEngineKey, BufferSelection, BufferSize,
        ClipSamples, ClipStoragePolicy, EngineCommand, InputPeakBank, LivePlugin, LoadedClip,
        MAX_INPUT_CHANNELS, MAX_OUTPUT_CHANNELS, MAX_PLUGIN_BLOCK_FRAMES, MEMORY_DECODE_LIMIT_BYTES,
        METRONOME_ACCENT_NOTE, METRONOME_BEAT_NOTE, MeterAtomics, MeterBank, MetronomeScheduler,
        NativeMixerChannel, NativeMixerGraph, NativeMixerRuntime, NativeMixerSend,
        NativePluginInstance, NativeRoundTripLatencyMeasurementRequest, Ordering,
        OUTPUT_RESAMPLER_FRAMES, RoundTripInputDetector, RoundTripLatencyMeasurement,
        RoundTripOutputProbe, ScheduledMidiEvent, SessionOutputConverter, SignalWidth,
        StereoDelayLine, StreamDirection, StreamErrorImpact, SupportedBufferSize, TRANSPORT_PLAYING,
        TRANSPORT_STOPPED, TransportAction, TransportShared, clip_storage_policy,
        compiled_graph_snapshot, frames_to_nanos, native_graph_references_plugin,
        resolve_stream_devices, select_buffer_size, set_last_native_graph_for_test,
        spawn_streaming_clip, stream_error_impact, validate_session_sample_rate,
    };
    use crate::recording::{
        NativeRecordingStartConfig, StereoFrame, write_deterministic_test_recording,
    };
    use crate::vst3::ProcessContext;
    use ringbuf::{
        HeapRb,
        traits::{Producer, Split},
    };
    use yadaw_dsp_core::mixer::{ChannelKind, ChannelSpec, MixerGraph, RouteTarget};
    use yadaw_dsp_render::{RenderMeter, RenderRuntime};
    use yadaw_dsp_runtime::protocol::{
        CompiledGraphNodeKind, CompiledGraphPluginState, LiveMixerSendTap, PluginAudioMode,
    };
    use yadaw_dsp_runtime::tempo::{TempoEvent, TempoMap, TimeSignatureEvent};

    fn assert_fixed(selection: BufferSelection, expected: u32, fell_back: bool) {
        assert!(matches!(selection.buffer_size, BufferSize::Fixed(value) if value == expected));
        assert_eq!(selection.expected_frames, expected);
        assert_eq!(selection.fell_back, fell_back);
    }

    #[test]
    fn keeps_a_supported_requested_buffer_size() {
        assert_fixed(
            select_buffer_size(&SupportedBufferSize::Range { min: 32, max: 512 }, 64),
            64,
            false,
        );
    }

    #[test]
    fn streams_only_assets_above_the_memory_decode_limit() {
        assert_eq!(
            clip_storage_policy(MEMORY_DECODE_LIMIT_BYTES),
            ClipStoragePolicy::Memory
        );
        assert_eq!(
            clip_storage_policy(MEMORY_DECODE_LIMIT_BYTES + 1),
            ClipStoragePolicy::Streaming
        );
    }

    #[test]
    fn falls_back_to_the_driver_default_outside_the_device_range() {
        let selection = select_buffer_size(&SupportedBufferSize::Range { min: 480, max: 480 }, 64);
        assert!(matches!(selection.buffer_size, BufferSize::Default));
        assert_eq!(selection.expected_frames, 480);
        assert!(selection.fell_back);
    }

    #[test]
    fn uses_the_driver_default_when_the_range_is_unknown() {
        let selection = select_buffer_size(&SupportedBufferSize::Unknown, 64);
        assert!(matches!(selection.buffer_size, BufferSize::Default));
        assert_eq!(selection.expected_frames, 64);
        assert!(selection.fell_back);
    }

    #[test]
    fn only_output_stream_xruns_are_user_visible() {
        assert_eq!(
            stream_error_impact(StreamDirection::Input, cpal::ErrorKind::Xrun),
            StreamErrorImpact::Ignore
        );
        assert_eq!(
            stream_error_impact(StreamDirection::Output, cpal::ErrorKind::Xrun),
            StreamErrorImpact::CountXrun
        );
        assert_eq!(
            stream_error_impact(StreamDirection::Output, cpal::ErrorKind::DeviceChanged),
            StreamErrorImpact::Ignore
        );
        assert_eq!(
            stream_error_impact(StreamDirection::Output, cpal::ErrorKind::BackendError),
            StreamErrorImpact::Fault
        );
    }

    #[test]
    fn matched_loopback_probe_reports_the_synthetic_physical_delay() {
        let measurement = Arc::new(RoundTripLatencyMeasurement::new(2, 2, 48_000));
        measurement
            .start(NativeRoundTripLatencyMeasurementRequest {
                input_channel: 2,
                output_channel: 2,
            })
            .unwrap();
        let mut detector = RoundTripInputDetector::new(Arc::clone(&measurement));
        let mut probe = RoundTripOutputProbe::new(Arc::clone(&measurement));

        for frame in 0..2_400 {
            detector.observe(&[0.0, 0.0], frames_to_nanos(frame, 48_000));
        }
        let emitted_at_ns = 1_000_000_000_u64;
        let mut captured_probe = Vec::new();
        for frame in 0..super::LOOPBACK_PROBE.len() {
            let mut output = [0.0, 0.0];
            probe.apply(
                &mut output,
                emitted_at_ns.saturating_add(frames_to_nanos(frame, 48_000)),
            );
            captured_probe.push(output[1]);
        }

        let delayed_frames = 480_usize;
        for frame in 0..delayed_frames {
            detector.observe(
                &[0.0, 0.0],
                emitted_at_ns.saturating_add(frames_to_nanos(frame, 48_000)),
            );
        }
        for (offset, sample) in captured_probe.into_iter().enumerate() {
            detector.observe(
                &[0.0, sample],
                emitted_at_ns.saturating_add(frames_to_nanos(delayed_frames + offset, 48_000)),
            );
        }

        let snapshot = measurement.snapshot();
        assert_eq!(snapshot.status, "complete");
        let latency = snapshot
            .measured_round_trip_latency_ms
            .expect("matched probe should produce latency");
        assert!((latency - 10.0).abs() < 0.02, "{latency}");
    }

    #[test]
    fn sinc_resampler_preserves_all_hardware_input_channels() {
        let ring = HeapRb::new(4_096);
        let (mut producer, consumer) = ring.split();
        for _ in 0..2_048 {
            let mut input = [0.0; MAX_INPUT_CHANNELS];
            input[0] = 0.25;
            input[MAX_INPUT_CHANNELS - 1] = -0.5;
            producer.try_push(input).expect("fixture ring has capacity");
        }
        let mut resampler =
            AdaptiveResampler::new(consumer, 48_000, 48_000, MAX_INPUT_CHANNELS, 1_024, 4_096)
                .expect("resampler configuration is valid");
        let mut output = [0.0; MAX_INPUT_CHANNELS];
        for _ in 0..512 {
            (output, _) = resampler.next_frame();
        }

        assert!((output[0] - 0.25).abs() < 0.01);
        assert!((output[MAX_INPUT_CHANNELS - 1] + 0.5).abs() < 0.01);
    }

    #[test]
    fn native_input_is_converted_to_the_session_rate_without_losing_channels() {
        let ring = HeapRb::new(8_192);
        let (mut producer, consumer) = ring.split();
        for _ in 0..4_096 {
            let mut input = [0.0; MAX_INPUT_CHANNELS];
            for (channel, sample) in input.iter_mut().enumerate() {
                *sample = (channel + 1) as f32 / MAX_INPUT_CHANNELS as f32;
            }
            producer.try_push(input).expect("fixture ring has capacity");
        }
        let mut resampler =
            AdaptiveResampler::new(consumer, 48_000, 44_100, MAX_INPUT_CHANNELS, 2_048, 8_192)
                .expect("resampler configuration is valid");
        let mut output = [0.0; MAX_INPUT_CHANNELS];
        for _ in 0..2_048 {
            (output, _) = resampler.next_frame();
        }

        for (channel, sample) in output.iter().enumerate() {
            let expected = (channel + 1) as f32 / MAX_INPUT_CHANNELS as f32;
            assert!((sample - expected).abs() < 0.01, "channel {channel}");
        }
    }

    fn rendered_session_frames(
        session_sample_rate: u32,
        output_sample_rate: u32,
        output_frames: usize,
    ) -> usize {
        let mut converter =
            SessionOutputConverter::new(session_sample_rate, output_sample_rate, 2).unwrap();
        let mut rendered = 0;
        let mut output = vec![[0.0; MAX_OUTPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES];
        let mut offset = 0;
        while offset < output_frames {
            let block_frames = (output_frames - offset).min(MAX_PLUGIN_BLOCK_FRAMES);
            let (_, frames) =
                converter.render_block(&mut output[..block_frames], |session_output| {
                    session_output.fill([0.0; MAX_OUTPUT_CHANNELS]);
                    false
                });
            rendered += frames;
            offset += block_frames;
        }
        rendered
    }

    #[test]
    fn session_output_converter_bypasses_equal_rates_exactly() {
        let converter = SessionOutputConverter::new(48_000, 48_000, 2).unwrap();
        assert!(matches!(converter, SessionOutputConverter::Bypass));
        assert_eq!(rendered_session_frames(48_000, 48_000, 48_000), 48_000);
    }

    #[test]
    fn session_output_converter_consumes_project_frames_at_44_1_and_96_khz() {
        for session_sample_rate in [44_100_u32, 96_000] {
            let rendered = rendered_session_frames(session_sample_rate, 48_000, 48_000);
            let expected = session_sample_rate as usize;
            assert!(
                rendered.abs_diff(expected) <= OUTPUT_RESAMPLER_FRAMES * 2,
                "{session_sample_rate} Hz rendered {rendered} frames, expected about {expected}"
            );
        }
    }

    #[test]
    fn session_output_converter_requests_session_audio_in_blocks() {
        let mut bypass = SessionOutputConverter::new(48_000, 48_000, 2).unwrap();
        let mut bypass_output = [[0.0; MAX_OUTPUT_CHANNELS]; 128];
        let mut bypass_calls = 0;
        let _ = bypass.render_block(&mut bypass_output, |block| {
            bypass_calls += 1;
            assert_eq!(block.len(), 128);
            false
        });
        assert_eq!(bypass_calls, 1);

        let mut resampled = SessionOutputConverter::new(44_100, 48_000, 2).unwrap();
        let mut resampled_output = [[0.0; MAX_OUTPUT_CHANNELS]; 1_024];
        let mut render_calls = 0;
        let _ = resampled.render_block(&mut resampled_output, |block| {
            render_calls += 1;
            assert!(block.len() > 1);
            block.fill([0.0; MAX_OUTPUT_CHANNELS]);
            false
        });
        assert!(render_calls < resampled_output.len());
    }

    #[test]
    fn session_output_converter_preserves_every_active_hardware_channel() {
        let mut converter =
            SessionOutputConverter::new(44_100, 48_000, MAX_OUTPUT_CHANNELS).unwrap();
        let mut outputs = [[0.0; MAX_OUTPUT_CHANNELS]; 4_096];
        let _ = converter.render_block(&mut outputs, |block| {
            for frame in block {
                for (channel, sample) in frame.iter_mut().enumerate() {
                    *sample = (channel + 1) as f32 / MAX_OUTPUT_CHANNELS as f32;
                }
            }
            false
        });
        let output = outputs[outputs.len() - 1];
        for (channel, sample) in output.iter().enumerate() {
            let expected = (channel + 1) as f32 / MAX_OUTPUT_CHANNELS as f32;
            assert!((sample - expected).abs() < 0.01, "channel {channel}");
        }
    }

    #[test]
    fn audio_engine_identity_includes_the_requested_session_rate() {
        let base = AudioEngineKey {
            backend: "virtual".to_owned(),
            input_device_id: "input".to_owned(),
            output_device_id: "output".to_owned(),
            requested_buffer_size: 128,
            requested_session_sample_rate: Some(44_100),
        };
        let same = base.clone();
        let changed = AudioEngineKey {
            requested_session_sample_rate: Some(96_000),
            ..base.clone()
        };
        assert_eq!(base, same);
        assert_ne!(base, changed);
    }

    #[test]
    fn graph_publication_rejects_a_different_session_rate() {
        assert!(validate_session_sample_rate(44_100, 44_100).is_ok());
        let error = validate_session_sample_rate(44_100, 48_000).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("mixer sample rate does not match")
        );
    }

    #[test]
    fn captures_multichannel_input_peaks_and_resets_the_snapshot() {
        let peaks = InputPeakBank::new();
        peaks.observe(&[0.25, -0.75, 1.25]);
        peaks.observe(&[-0.5, 0.5, 0.25]);
        let mut snapshot = [0.0; MAX_INPUT_CHANNELS];
        peaks.take_all(&mut snapshot);
        assert_eq!(&snapshot[..3], &[0.5, 0.75, 1.25]);
        peaks.take_all(&mut snapshot);
        assert_eq!(&snapshot[..3], &[0.0, 0.0, 0.0]);
    }

    #[test]
    fn asio_resolves_one_shared_device_for_duplex_streams() {
        let mut calls = Vec::new();
        let (input, output) =
            resolve_stream_devices("asio", "us-1x2hr", "us-1x2hr", |id, input| {
                calls.push((id.to_owned(), input));
                Ok(id.to_owned())
            })
            .unwrap();

        assert_eq!(input, "us-1x2hr");
        assert_eq!(output, "us-1x2hr");
        assert_eq!(calls, [("us-1x2hr".to_owned(), true)]);
    }

    #[test]
    fn non_asio_backends_resolve_independent_input_and_output_devices() {
        let mut calls = Vec::new();
        resolve_stream_devices("wasapi", "microphone", "speakers", |id, input| {
            calls.push((id.to_owned(), input));
            Ok(id.to_owned())
        })
        .unwrap();

        assert_eq!(
            calls,
            [
                ("microphone".to_owned(), true),
                ("speakers".to_owned(), false)
            ]
        );
    }

    #[test]
    fn asio_rejects_different_input_and_output_drivers() {
        let result = resolve_stream_devices("asio", "input-driver", "output-driver", |_, _| {
            Ok(String::new())
        });

        assert!(result.is_err());
    }

    #[test]
    fn metronome_starts_on_an_exact_beat_and_releases_after_twenty_ms() {
        let map = TempoMap::default_120_bpm();
        let mut scheduler = MetronomeScheduler::new(Some(2), &map, 48_000, 0);

        let at_origin = scheduler.events_at(&map, 48_000, 0);
        let note_on = at_origin.into_iter().flatten().find(|event| event.note_on);
        assert!(note_on.is_some_and(|event| {
            event.channel_index == 2 && event.key == METRONOME_ACCENT_NOTE
        }));
        assert!(scheduler.events_at(&map, 48_000, 959)[0].is_none());
        let release = scheduler.events_at(&map, 48_000, 960);
        assert!(
            release
                .into_iter()
                .flatten()
                .any(|event| !event.note_on && event.key == METRONOME_ACCENT_NOTE)
        );
        assert_eq!(scheduler.next.map(|boundary| boundary.frame), Some(24_000));
    }

    #[test]
    fn metronome_seek_waits_for_the_next_beat_unless_seek_is_exact() {
        let map = TempoMap::default_120_bpm();
        let mut scheduler = MetronomeScheduler::new(Some(0), &map, 48_000, 12_000);
        assert_eq!(scheduler.next.map(|boundary| boundary.frame), Some(24_000));
        assert!(scheduler.events_at(&map, 48_000, 12_000)[0].is_none());

        scheduler.reposition(&map, 48_000, 24_000, true);
        let exact = scheduler.events_at(&map, 48_000, 24_000);
        assert!(
            exact
                .into_iter()
                .flatten()
                .any(|event| event.note_on && event.key == METRONOME_BEAT_NOTE)
        );
    }

    #[test]
    fn metronome_uses_the_signature_denominator_and_restarts_at_markers() {
        let map = TempoMap::new(
            vec![TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            vec![
                TimeSignatureEvent {
                    tick: 0,
                    numerator: 6,
                    denominator: 8,
                },
                TimeSignatureEvent {
                    tick: 3_000,
                    numerator: 3,
                    denominator: 4,
                },
            ],
        )
        .unwrap();
        let mut scheduler = MetronomeScheduler::new(Some(0), &map, 48_000, 1);
        assert_eq!(scheduler.next.map(|boundary| boundary.tick), Some(480));
        assert!(!scheduler.next.is_some_and(|boundary| boundary.accent));

        scheduler.reposition(&map, 48_000, 73_000, true);
        assert_eq!(scheduler.next.map(|boundary| boundary.tick), Some(3_000));
        assert!(scheduler.next.is_some_and(|boundary| boundary.accent));
    }

    #[test]
    fn metronome_frames_follow_step_tempo_changes() {
        let map = TempoMap::new(
            vec![
                TempoEvent {
                    tick: 0,
                    beats_per_minute: 120.0,
                },
                TempoEvent {
                    tick: 1_920,
                    beats_per_minute: 60.0,
                },
            ],
            vec![TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        )
        .unwrap();
        let scheduler = MetronomeScheduler::new(Some(0), &map, 48_000, 48_001);
        assert_eq!(scheduler.next.map(|boundary| boundary.tick), Some(2_880));
        assert_eq!(scheduler.next.map(|boundary| boundary.frame), Some(96_000));
    }

    #[test]
    fn streaming_clip_prefetches_and_restarts_after_a_seek_generation() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "yadaw-streaming-{}-{nonce}.bwf",
            std::process::id()
        ));
        write_deterministic_test_recording(
            NativeRecordingStartConfig {
                path: path.to_string_lossy().into_owned(),
                asset_id: "streaming-test".to_owned(),
                originator: "YADAW test".to_owned(),
                origination_date: "2026-07-24".to_owned(),
                origination_time: "12:00:00".to_owned(),
                time_reference: 0,
            },
            48_000,
            4_800,
        )
        .unwrap();
        let (mut stream, frames) =
            spawn_streaming_clip(path.to_string_lossy().into_owned(), 48_000, 0).unwrap();
        assert_eq!(frames, 4_800);
        assert!(stream.sample_at(0).is_some());

        let mut refilled = false;
        for frame in 1_234..1_334 {
            if stream.sample_at(frame).is_some() {
                refilled = true;
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(refilled);
        drop(stream);
        fs::remove_file(path).unwrap();
    }

    fn test_process_context() -> ProcessContext {
        ProcessContext {
            project_time_samples: 0,
            continuous_time_samples: 0,
            project_time_quarters: 0.0,
            bar_position_quarters: 0.0,
            tempo: 120.0,
            time_signature_numerator: 4,
            time_signature_denominator: 4,
            playing: false,
            recording: false,
        }
    }

    fn missing_effect(mode: PluginAudioMode, enabled: bool) -> LivePlugin {
        LivePlugin {
            processor: None,
            audio_mode: mode,
            enabled,
            is_instrument: false,
            bypass_delay: StereoDelayLine::new(0),
            marker_index: 0,
        }
    }

    fn process_test_plugin(
        plugin: &mut LivePlugin,
        input: StereoFrame,
        width: &mut SignalWidth,
        context: &ProcessContext,
    ) -> StereoFrame {
        let mut frames = [input];
        plugin.process_block(&mut frames, width, context);
        frames[0]
    }

    #[test]
    fn hidden_channel_adapters_downmix_and_upmix_at_chain_boundaries() {
        let context = test_process_context();
        let mut width = SignalWidth::Stereo;
        let mut mono = missing_effect(PluginAudioMode::Mono, true);
        let frame = process_test_plugin(&mut mono, [1.0, 3.0], &mut width, &context);
        assert_eq!(frame, [2.0, 0.0]);
        assert!(matches!(width, SignalWidth::Mono));

        let mut stereo = missing_effect(PluginAudioMode::Stereo, true);
        let frame = process_test_plugin(&mut stereo, frame, &mut width, &context);
        assert_eq!(frame, [2.0, 2.0]);
        assert!(matches!(width, SignalWidth::Stereo));
    }

    #[test]
    fn bypassed_modes_keep_their_selected_topology() {
        let context = test_process_context();
        let mut width = SignalWidth::Stereo;
        let mut mono_to_stereo = missing_effect(PluginAudioMode::MonoToStereo, false);
        let frame =
            process_test_plugin(&mut mono_to_stereo, [1.0, 3.0], &mut width, &context);
        assert_eq!(frame, [2.0, 2.0]);
        assert!(matches!(width, SignalWidth::Stereo));

        let mut mono = missing_effect(PluginAudioMode::Mono, false);
        let frame = process_test_plugin(&mut mono, frame, &mut width, &context);
        assert_eq!(frame, [2.0, 0.0]);
        assert!(matches!(width, SignalWidth::Mono));
    }

    #[test]
    fn every_adjacent_effect_mode_pair_has_a_legal_hidden_adapter_path() {
        use PluginAudioMode::{DualMono, Mono, MonoToStereo, Stereo};

        let cases = [
            (Mono, Mono, [2.0, 0.0], true),
            (Mono, MonoToStereo, [2.0, 2.0], false),
            (Mono, Stereo, [2.0, 2.0], false),
            (Mono, DualMono, [2.0, 2.0], false),
            (MonoToStereo, Mono, [2.0, 0.0], true),
            (MonoToStereo, MonoToStereo, [2.0, 2.0], false),
            (MonoToStereo, Stereo, [2.0, 2.0], false),
            (MonoToStereo, DualMono, [2.0, 2.0], false),
            (Stereo, Mono, [2.0, 0.0], true),
            (Stereo, MonoToStereo, [2.0, 2.0], false),
            (Stereo, Stereo, [1.0, 3.0], false),
            (Stereo, DualMono, [1.0, 3.0], false),
            (DualMono, Mono, [2.0, 0.0], true),
            (DualMono, MonoToStereo, [2.0, 2.0], false),
            (DualMono, Stereo, [1.0, 3.0], false),
            (DualMono, DualMono, [1.0, 3.0], false),
        ];
        let context = test_process_context();

        for (first_mode, second_mode, expected, expected_mono) in cases {
            let mut width = SignalWidth::Stereo;
            let mut first = missing_effect(first_mode, false);
            let mut second = missing_effect(second_mode, false);
            let frame = process_test_plugin(&mut first, [1.0, 3.0], &mut width, &context);
            let frame = process_test_plugin(&mut second, frame, &mut width, &context);
            assert_eq!(
                frame, expected,
                "{first_mode:?} followed by {second_mode:?}"
            );
            assert_eq!(
                matches!(width, SignalWidth::Mono),
                expected_mono,
                "{first_mode:?} followed by {second_mode:?}"
            );
        }
    }

    #[test]
    fn compiled_snapshot_exposes_adapters_plugin_states_and_route_pdc() {
        fn channel(
            id: &str,
            output_index: Option<u32>,
            input_channels: Vec<u32>,
        ) -> NativeMixerChannel {
            NativeMixerChannel {
                id: id.to_owned(),
                kind: if id == "output" { "output" } else { "audio" }.to_owned(),
                system_role: None,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output_index,
                output_bus: None,
                record_armed: false,
                input_monitoring: false,
                input_source: (id != "output").then(|| "hardware".to_owned()),
                input_channels,
                hardware_output_channels: (id == "output")
                    .then_some(vec![1, 2])
                    .unwrap_or_default(),
            }
        }
        let graph = NativeMixerGraph {
            generation: 17,
            sample_rate: 48_000,
            channels: vec![
                channel("wet", Some(3), vec![1]),
                channel("send-source", None, vec![2, 3]),
                channel("dry", Some(3), vec![4, 5]),
                channel("output", None, Vec::new()),
            ],
            sends: vec![NativeMixerSend {
                id: "parallel".to_owned(),
                source_index: 1,
                target_output_index: Some(3),
                target_bus: None,
                enabled: true,
                tap: LiveMixerSendTap::PostPan,
                level_db: 0.0,
            }],
            clips: Vec::new(),
            plugins: vec![
                NativePluginInstance {
                    instance_id: "missing".to_owned(),
                    channel_index: 0,
                    role: "insert".to_owned(),
                    slot_order: 0,
                    audio_mode: PluginAudioMode::Stereo,
                    enabled: true,
                    latency_samples: 64,
                    tail_samples: Some(0),
                    processor: None,
                },
                NativePluginInstance {
                    instance_id: "bypassed".to_owned(),
                    channel_index: 1,
                    role: "insert".to_owned(),
                    slot_order: 0,
                    audio_mode: PluginAudioMode::Stereo,
                    enabled: false,
                    latency_samples: 32,
                    tail_samples: Some(0),
                    processor: None,
                },
            ],
            midi_clips: Vec::new(),
            tempo_events: Vec::new(),
            time_signature_events: Vec::new(),
        };

        let snapshot = compiled_graph_snapshot(&graph, 23);

        assert_eq!(snapshot.graph_revision, 17);
        assert_eq!(snapshot.build_generation, 23);
        assert!(snapshot.nodes.iter().any(|node| {
            node.kind == CompiledGraphNodeKind::WidthAdapter
                && node.channel_id.as_deref() == Some("wet")
        }));
        assert!(
            snapshot
                .nodes
                .iter()
                .any(|node| { node.plugin_state == Some(CompiledGraphPluginState::Unavailable) })
        );
        assert!(
            snapshot
                .nodes
                .iter()
                .any(|node| { node.plugin_state == Some(CompiledGraphPluginState::Bypassed) })
        );
        assert!(snapshot.nodes.iter().any(|node| {
            node.kind == CompiledGraphNodeKind::PdcDelay
                && node.label == "Channel PDC"
                && node.latency_samples == 64
        }));
        assert!(snapshot.nodes.iter().any(|node| {
            node.kind == CompiledGraphNodeKind::PdcDelay
                && node.label == "Send PDC"
                && node.latency_samples == 32
        }));
        assert!(snapshot.nodes.iter().any(|node| {
            node.kind == CompiledGraphNodeKind::PdcDelay
                && node.label == "Bypass compensation"
                && node.latency_samples == 32
        }));
    }

    #[test]
    fn native_graph_plugin_references_follow_the_last_candidate_graph() {
        set_last_native_graph_for_test(None);
        assert!(!native_graph_references_plugin("bench-0"));

        set_last_native_graph_for_test(Some(NativeMixerGraph {
            generation: 1,
            sample_rate: 48_000,
            channels: Vec::new(),
            sends: Vec::new(),
            clips: Vec::new(),
            plugins: vec![NativePluginInstance {
                instance_id: "session-fx".to_owned(),
                channel_index: 0,
                role: "insert".to_owned(),
                slot_order: 0,
                audio_mode: PluginAudioMode::Stereo,
                enabled: true,
                latency_samples: 0,
                tail_samples: Some(0),
                processor: None,
            }],
            midi_clips: Vec::new(),
            tempo_events: Vec::new(),
            time_signature_events: Vec::new(),
        }));
        assert!(native_graph_references_plugin("session-fx"));
        assert!(!native_graph_references_plugin("bench-0"));
        set_last_native_graph_for_test(None);
    }

    fn transport_test_runtime(
        sample_rate: u32,
        content_end_frame: u64,
        position_frames: u64,
        state: u32,
    ) -> Box<NativeMixerRuntime> {
        let channels = vec![
            ChannelSpec {
                id: "audio-0".to_owned(),
                kind: ChannelKind::Audio,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output: Some(RouteTarget::Output(2)),
                input_bus: None,
                hardware_output: None,
            },
            ChannelSpec {
                id: "master".to_owned(),
                kind: ChannelKind::Master,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output: None,
                input_bus: None,
                hardware_output: None,
            },
            ChannelSpec {
                id: "output".to_owned(),
                kind: ChannelKind::Output,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output: None,
                input_bus: None,
                hardware_output: Some([0, 1]),
            },
        ];
        let graph = MixerGraph::new(sample_rate, channels, Vec::new())
            .expect("transport test graph must be valid");
        let mut graph =
            RenderRuntime::from_mixer_graph(sample_rate, graph, TempoMap::default_120_bpm());
        graph.prepare_block_processing(MAX_PLUGIN_BLOCK_FRAMES);
        let length_frames = content_end_frame.max(1) as usize;
        Box::new(NativeMixerRuntime {
            generation: 1,
            build_generation: 1,
            peak_scratch: vec![
                RenderMeter {
                    pre: [0.0; 2],
                    post: [0.0; 2],
                };
                3
            ],
            held_peaks: vec![[0.0, 0.0]; 3],
            held_until: vec![[0, 0]; 3],
            channel_source_block: vec![[0.0, 0.0]; 3usize.saturating_mul(MAX_PLUGIN_BLOCK_FRAMES)],
            channel_input_widths: vec![SignalWidth::Stereo; 3],
            plugins_by_channel: vec![Vec::new(), Vec::new(), Vec::new()],
            midi_events: Vec::new(),
            midi_cursor: 0,
            active_notes: Vec::new(),
            metronome: MetronomeScheduler::new(None, &TempoMap::default_120_bpm(), sample_rate, 0),
            tempo_map: TempoMap::default_120_bpm(),
            graph,
            clips: vec![LoadedClip {
                channel_index: 0,
                start_frame: 0,
                source_offset_frames: 0,
                length_frames,
                samples: ClipSamples::Memory(vec![[0.25, -0.25]; length_frames]),
            }],
            meter_bank: Arc::new(MeterBank {
                channels: (0..3)
                    .map(|index| MeterAtomics::new(format!("channel-{index}")))
                    .collect(),
            }),
            transport: Arc::new(TransportShared {
                state: AtomicU32::new(state),
                position_frames: AtomicU64::new(position_frames),
                sample_rate: AtomicU32::new(sample_rate),
            }),
            sample_rate,
            content_end_frame,
            tail_end_frame: Some(content_end_frame),
            has_infinite_tail: false,
            input_peaks: Arc::new(InputPeakBank::new()),
            input_meter_routes: vec![None; 3],
            monitor_input_routes: vec![None; 3],
            input_peak_scratch: [0.0; MAX_INPUT_CHANNELS],
            meter_frame_clock: 0,
        })
    }

    #[test]
    fn play_at_content_end_rewinds_before_starting() {
        let mut runtime = transport_test_runtime(48_000, 1_000, 1_000, TRANSPORT_STOPPED);

        let _ = runtime.handle_command(EngineCommand::Transport(TransportAction::Play, 0));

        assert_eq!(
            runtime.transport.state.load(Ordering::Relaxed),
            TRANSPORT_PLAYING
        );
        assert_eq!(runtime.transport.position_frames.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn play_before_content_end_keeps_current_position() {
        let mut runtime = transport_test_runtime(48_000, 1_000, 250, TRANSPORT_STOPPED);

        let _ = runtime.handle_command(EngineCommand::Transport(TransportAction::Play, 0));

        assert_eq!(
            runtime.transport.state.load(Ordering::Relaxed),
            TRANSPORT_PLAYING
        );
        assert_eq!(
            runtime.transport.position_frames.load(Ordering::Relaxed),
            250
        );
    }

    #[test]
    fn auto_stop_at_content_end_then_play_restarts_from_beginning() {
        let mut runtime = transport_test_runtime(48_000, 1_000, 980, TRANSPORT_PLAYING);
        let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 64];
        let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 64];

        let underrun = runtime.render_block(&inputs, &mut outputs);
        assert!(!underrun);
        assert_eq!(
            runtime.transport.state.load(Ordering::Relaxed),
            TRANSPORT_STOPPED
        );
        assert!(runtime.transport.position_frames.load(Ordering::Relaxed) >= 1_000);

        let _ = runtime.handle_command(EngineCommand::Transport(TransportAction::Play, 0));
        assert_eq!(
            runtime.transport.state.load(Ordering::Relaxed),
            TRANSPORT_PLAYING
        );
        assert_eq!(runtime.transport.position_frames.load(Ordering::Relaxed), 0);

        let underrun = runtime.render_block(&inputs[..32], &mut outputs[..32]);
        assert!(!underrun);
        assert_eq!(
            runtime.transport.state.load(Ordering::Relaxed),
            TRANSPORT_PLAYING
        );
        assert_eq!(
            runtime.transport.position_frames.load(Ordering::Relaxed),
            32
        );
    }

    #[test]
    fn render_block_consumes_scheduled_midi_exactly_up_to_the_block_end() {
        let mut runtime = transport_test_runtime(48_000, 1_000, 5, TRANSPORT_PLAYING);
        let event = |frame: u64, note_id: i32| ScheduledMidiEvent {
            frame,
            channel_index: 0,
            note_id,
            channel: 0,
            key: 60,
            velocity: 100,
            note_on: true,
        };
        runtime.midi_events = vec![
            event(2, 0),
            event(10, 1),
            event(63, 2),
            event(68, 3),
            event(69, 4),
        ];
        runtime.active_notes = vec![false; 5];
        let inputs = vec![[0.0; MAX_INPUT_CHANNELS]; 64];
        let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; 64];

        let underrun = runtime.render_block(&inputs, &mut outputs);

        assert!(!underrun);
        // Rendering frames 5..69 consumes every event before the block end —
        // including the stale frame-2 event behind the playhead — exactly once,
        // while the frame-69 event stays queued for the next block.
        assert_eq!(runtime.midi_cursor, 4);
    }
}
