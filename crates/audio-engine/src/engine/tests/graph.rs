use super::*;

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
    let frame = process_test_plugin(&mut mono_to_stereo, [1.0, 3.0], &mut width, &context);
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
            name: id.to_owned(),
            color: "#000000".to_owned(),
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
            application_capture: None,
            hardware_output_channels: (id == "output").then_some(vec![1, 2]).unwrap_or_default(),
            midi_input_port_id: None,
            midi_input_channel: None,
        }
    }
    let graph = NativeMixerGraph {
        generation: 17,
        sample_rate: 48_000,
        project_end_tick: 61_440,
        latency_policy: NativeLatencyPolicy::Normal,
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
                aux_input_buses: Vec::new(),
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
                aux_input_buses: Vec::new(),
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
fn parse_channel_kind_accepts_known_kinds_and_rejects_unknown() {
    assert!(matches!(
        parse_channel_kind("audio").unwrap(),
        ChannelKind::Audio
    ));
    assert!(matches!(
        parse_channel_kind("instrument").unwrap(),
        ChannelKind::Instrument
    ));
    assert!(matches!(
        parse_channel_kind("aux").unwrap(),
        ChannelKind::Aux
    ));
    assert!(matches!(
        parse_channel_kind("master").unwrap(),
        ChannelKind::Master
    ));
    assert!(matches!(
        parse_channel_kind("output").unwrap(),
        ChannelKind::Output
    ));
    assert!(parse_channel_kind("bus").is_err());
    assert!(parse_channel_kind("").is_err());
}

#[test]
fn build_mixer_runtime_rejects_unknown_channel_kinds() {
    let mut graph = simple_native_graph();
    graph.channels[0].kind = "group".into();
    assert_build_err(
        build_mixer_runtime(
            graph,
            1,
            test_transport(48_000),
            Arc::new(InputPeakBank::new()),
        ),
        "unknown mixer channel kind",
    );
}

#[test]
fn build_mixer_runtime_rejects_dual_output_targets() {
    let mut graph = simple_native_graph();
    graph.channels[0].output_index = Some(2);
    graph.channels[0].output_bus = Some(1);
    assert_build_err(
        build_mixer_runtime(
            graph,
            1,
            test_transport(48_000),
            Arc::new(InputPeakBank::new()),
        ),
        "either a BUS or an Output",
    );
}

#[test]
fn build_mixer_runtime_rejects_instrument_plugin_on_audio_track() {
    let mut graph = simple_native_graph();
    graph.plugins.push(NativePluginInstance {
        instance_id: "synth".into(),
        channel_index: 0,
        role: "instrument".into(),
        slot_order: 0,
        audio_mode: PluginAudioMode::Stereo,
        enabled: true,
        aux_input_buses: Vec::new(),
        latency_samples: 0,
        tail_samples: Some(0),
        processor: None,
    });
    assert_build_err(
        build_mixer_runtime(
            graph,
            1,
            test_transport(48_000),
            Arc::new(InputPeakBank::new()),
        ),
        "instrument plugin is assigned to a non-instrument track",
    );
}

#[test]
fn build_mixer_runtime_compiles_a_simple_graph_with_monitoring_and_pdc() {
    let mut graph = simple_native_graph();
    graph.channels[0].input_monitoring = true;
    graph.plugins.push(NativePluginInstance {
        instance_id: "fx".into(),
        channel_index: 0,
        role: "insert".into(),
        slot_order: 0,
        audio_mode: PluginAudioMode::Mono,
        enabled: true,
        aux_input_buses: Vec::new(),
        latency_samples: 32,
        tail_samples: Some(64),
        processor: None,
    });
    let runtime = build_mixer_runtime(
        graph,
        9,
        test_transport(48_000),
        Arc::new(InputPeakBank::new()),
    )
    .expect("simple graph");
    assert_eq!(runtime.generation, 3);
    assert_eq!(runtime.build_generation, 9);
    assert_eq!(runtime.sample_rate, 48_000);
    assert_eq!(runtime.plugins_by_channel[0].len(), 1);
    assert!(matches!(
        runtime.channel_input_widths[0],
        SignalWidth::Stereo
    ));
    assert!(runtime.monitor_input_routes[0].is_some());
    assert_eq!(runtime.tail_end_frame, Some(64));
    assert!(!runtime.has_infinite_tail);
}

#[test]
fn sidechain_pdc_aligns_at_the_target_plugin_slot() {
    let mut graph = simple_native_graph();
    graph.channels.insert(
        1,
        mixer_channel(
            "sidechain-target",
            "audio",
            Some(3),
            None,
            Some("hardware"),
            vec![3, 4],
            Vec::new(),
        ),
    );
    graph.channels[0].output_index = Some(3);
    graph.plugins = vec![
        NativePluginInstance {
            instance_id: "source-latency".into(),
            channel_index: 0,
            role: "insert".into(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: Vec::new(),
            latency_samples: 64,
            tail_samples: Some(0),
            processor: None,
        },
        NativePluginInstance {
            instance_id: "sidechain-target".into(),
            channel_index: 1,
            role: "insert".into(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: vec![NativePluginAuxInputBus {
                input_bus_index: 1,
                name: "Side-chain".into(),
                channels: 2,
                source_index: Some(0),
            }],
            latency_samples: 0,
            tail_samples: Some(0),
            processor: None,
        },
    ];

    let snapshot = compiled_graph_snapshot(&graph, 1);
    let route = snapshot
        .edges
        .iter()
        .find(|edge| edge.kind == CompiledGraphEdgeKind::SidechainRoute)
        .expect("side-chain diagnostic edge");
    assert_eq!(route.target_input_bus_index, Some(1));
    assert_eq!(route.signal_width, CompiledGraphSignalWidth::Stereo);
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| { node.id == "pdc:main:sidechain-target" && node.latency_samples == 64 })
    );

    let runtime = build_mixer_runtime(
        graph,
        1,
        test_transport(48_000),
        Arc::new(InputPeakBank::new()),
    )
    .expect("side-chain graph");
    let target = &runtime.plugins_by_channel[1][0];
    assert_eq!(target.main_delay.delay_frames(), 64);
    assert_eq!(target.aux_inputs[0].delay.delay_frames(), 0);
}

#[test]
fn sidechain_pdc_delays_an_earlier_aux_source_at_a_later_slot() {
    let mut graph = simple_native_graph();
    graph.channels.insert(
        1,
        mixer_channel(
            "sidechain-target",
            "audio",
            Some(3),
            None,
            Some("hardware"),
            vec![3, 4],
            Vec::new(),
        ),
    );
    graph.channels[0].output_index = Some(3);
    graph.plugins = vec![
        NativePluginInstance {
            instance_id: "target-latency".into(),
            channel_index: 1,
            role: "insert".into(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: Vec::new(),
            latency_samples: 64,
            tail_samples: Some(0),
            processor: None,
        },
        NativePluginInstance {
            instance_id: "sidechain-target".into(),
            channel_index: 1,
            role: "insert".into(),
            slot_order: 1,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: vec![NativePluginAuxInputBus {
                input_bus_index: 2,
                name: "Key".into(),
                channels: 1,
                source_index: Some(0),
            }],
            latency_samples: 0,
            tail_samples: Some(0),
            processor: None,
        },
    ];

    let snapshot = compiled_graph_snapshot(&graph, 2);
    assert!(snapshot.nodes.iter().any(|node| {
        node.id == "pdc:sidechain:sidechain-target:2" && node.latency_samples == 64
    }));
    let route = snapshot
        .edges
        .iter()
        .find(|edge| edge.kind == CompiledGraphEdgeKind::SidechainRoute)
        .expect("side-chain diagnostic edge");
    assert_eq!(route.target_input_bus_index, Some(2));
    assert_eq!(route.signal_width, CompiledGraphSignalWidth::Mono);
    assert!(route.source.starts_with("pdc:sidechain:"));

    let runtime = build_mixer_runtime(
        graph,
        2,
        test_transport(48_000),
        Arc::new(InputPeakBank::new()),
    )
    .expect("side-chain graph");
    let target = &runtime.plugins_by_channel[1][1];
    assert_eq!(target.main_delay.delay_frames(), 0);
    assert_eq!(target.aux_inputs[0].delay.delay_frames(), 64);
}

#[test]
fn sidechain_graph_validation_rejects_every_invalid_bus_shape() {
    for (target, source, channels) in [(3, 0, 2), (0, 3, 2), (0, 0, 2), (1, 0, 3)] {
        let mut graph = simple_native_graph();
        graph.plugins.push(NativePluginInstance {
            instance_id: "invalid-sidechain".into(),
            channel_index: target,
            role: "insert".into(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: vec![NativePluginAuxInputBus {
                input_bus_index: 1,
                name: "Invalid".into(),
                channels,
                source_index: Some(source),
            }],
            latency_samples: 0,
            tail_samples: Some(0),
            processor: None,
        });

        let result = build_mixer_runtime(
            graph,
            1,
            test_transport(48_000),
            Arc::new(InputPeakBank::new()),
        );
        let Err(error) = result else {
            panic!("invalid side-chain route was accepted");
        };
        assert!(error.to_string().contains("side-chain route is invalid"));
    }

    let mut disconnected = simple_native_graph();
    disconnected.plugins.push(NativePluginInstance {
        instance_id: "disconnected-sidechain".into(),
        channel_index: 0,
        role: "insert".into(),
        slot_order: 0,
        audio_mode: PluginAudioMode::Stereo,
        enabled: true,
        aux_input_buses: vec![NativePluginAuxInputBus {
            input_bus_index: 1,
            name: "Disconnected".into(),
            channels: 2,
            source_index: None,
        }],
        latency_samples: 0,
        tail_samples: Some(0),
        processor: None,
    });
    let runtime = build_mixer_runtime(
        disconnected,
        1,
        test_transport(48_000),
        Arc::new(InputPeakBank::new()),
    )
    .expect("inactive aux buses are ignored");
    assert!(runtime.plugins_by_channel[0][0].aux_inputs.is_empty());
}

#[test]
fn build_mixer_runtime_schedules_midi_notes_and_controller_events() {
    let mut graph = simple_native_graph();
    graph.channels.insert(
        0,
        mixer_channel(
            "instrument-0",
            "instrument",
            Some(3),
            None,
            None,
            Vec::new(),
            Vec::new(),
        ),
    );
    // Remap audio/master/output after inserting the instrument track.
    graph.channels[1].output_index = Some(3);
    graph.midi_clips.push(NativeMidiClip {
        id: "clip".into(),
        channel_index: 0,
        start_tick: 0,
        source_offset_ticks: 0,
        length_ticks: 1_920,
        notes: vec![NativeMidiNote {
            start_tick: 0,
            duration_ticks: 480,
            channel: 0,
            key: 60,
            velocity: 100,
            release_velocity: 0,
        }],
        events: vec![
            NativeMidiEvent {
                tick: 240,
                channel: 0,
                kind: NativeMidiEventKind::ControlChange {
                    controller: 1,
                    value: 64,
                },
            },
            NativeMidiEvent {
                tick: 480,
                channel: 0,
                kind: NativeMidiEventKind::PitchBend { value: 8_192 },
            },
            NativeMidiEvent {
                tick: 720,
                channel: 0,
                kind: NativeMidiEventKind::ProgramChange { program: 12 },
            },
            NativeMidiEvent {
                tick: 960,
                channel: 0,
                kind: NativeMidiEventKind::ChannelPressure { pressure: 40 },
            },
            NativeMidiEvent {
                tick: 1_200,
                channel: 0,
                kind: NativeMidiEventKind::PolyPressure {
                    key: 61,
                    pressure: 50,
                },
            },
            NativeMidiEvent {
                tick: 1_440,
                channel: 0,
                kind: NativeMidiEventKind::SysEx {
                    data: vec![0xF0, 0x7E, 0xF7],
                },
            },
        ],
    });
    let runtime = build_mixer_runtime(
        graph,
        2,
        test_transport(48_000),
        Arc::new(InputPeakBank::new()),
    )
    .expect("midi graph");
    assert!(runtime.midi_events.len() >= 8);
    assert!(
        runtime
            .midi_events
            .iter()
            .any(|event| matches!(event.kind, ScheduledMidiEventKind::NoteOn { key: 60, .. }))
    );
    assert!(
        runtime
            .midi_events
            .iter()
            .any(|event| matches!(event.kind, ScheduledMidiEventKind::SysEx { .. }))
    );
    assert_eq!(&runtime.midi_event_data[..], &[0xF0, 0x7E, 0xF7]);
    assert!(runtime.content_end_frame > 0);
}

#[test]
fn build_mixer_runtime_routes_bus_sends_and_metronome_channels() {
    let graph = NativeMixerGraph {
        generation: 5,
        sample_rate: 48_000,
        project_end_tick: 61_440,
        latency_policy: NativeLatencyPolicy::Normal,
        channels: vec![
            {
                let mut channel = mixer_channel(
                    "audio-0",
                    "audio",
                    None,
                    Some(1),
                    Some("hardware"),
                    vec![1],
                    Vec::new(),
                );
                channel.record_armed = true;
                channel
            },
            mixer_channel(
                "aux-0",
                "aux",
                Some(4),
                None,
                Some("bus"),
                vec![1],
                Vec::new(),
            ),
            {
                let mut metronome = mixer_channel(
                    "metronome",
                    "instrument",
                    Some(4),
                    None,
                    None,
                    Vec::new(),
                    Vec::new(),
                );
                metronome.system_role = Some(LiveMixerSystemRole::Metronome);
                metronome
            },
            mixer_channel("master", "master", None, None, None, Vec::new(), Vec::new()),
            mixer_channel("output", "output", None, None, None, Vec::new(), vec![1, 2]),
        ],
        sends: vec![NativeMixerSend {
            id: "to-aux".into(),
            source_index: 0,
            target_output_index: None,
            target_bus: Some(1),
            enabled: true,
            tap: LiveMixerSendTap::Pre,
            level_db: -6.0,
        }],
        clips: Vec::new(),
        plugins: Vec::new(),
        midi_clips: Vec::new(),
        tempo_events: vec![TempoEvent {
            tick: 0,
            beats_per_minute: 120.0,
        }],
        time_signature_events: vec![TimeSignatureEvent {
            tick: 0,
            numerator: 4,
            denominator: 4,
        }],
    };
    let runtime = build_mixer_runtime(
        graph,
        4,
        test_transport(48_000),
        Arc::new(InputPeakBank::new()),
    )
    .expect("bus graph");
    assert!(matches!(runtime.channel_input_widths[0], SignalWidth::Mono));
    assert_eq!(runtime.input_meter_routes[0], Some([0, 0]));
    assert_eq!(runtime.metronome.channel_index, Some(2));
    assert!(runtime.live_midi_routes[2].is_none());
}

#[test]
fn compiled_snapshot_covers_instrument_bus_master_and_active_plugin_paths() {
    let graph = NativeMixerGraph {
        generation: 11,
        sample_rate: 48_000,
        project_end_tick: 61_440,
        latency_policy: NativeLatencyPolicy::Normal,
        channels: vec![
            mixer_channel(
                "instrument-0",
                "instrument",
                None,
                Some(1),
                None,
                Vec::new(),
                Vec::new(),
            ),
            mixer_channel(
                "aux-0",
                "aux",
                Some(3),
                None,
                Some("bus"),
                vec![1, 2],
                Vec::new(),
            ),
            mixer_channel(
                "master",
                "master",
                Some(3),
                None,
                None,
                Vec::new(),
                Vec::new(),
            ),
            mixer_channel("output", "output", None, None, None, Vec::new(), vec![1, 2]),
        ],
        sends: vec![NativeMixerSend {
            id: "bus-send".into(),
            source_index: 0,
            target_output_index: None,
            target_bus: Some(1),
            enabled: false,
            tap: LiveMixerSendTap::Post,
            level_db: -3.0,
        }],
        clips: Vec::new(),
        plugins: vec![NativePluginInstance {
            instance_id: "active".into(),
            channel_index: 0,
            role: "instrument".into(),
            slot_order: 0,
            audio_mode: PluginAudioMode::DualMono,
            enabled: true,
            aux_input_buses: Vec::new(),
            latency_samples: 0,
            tail_samples: None,
            processor: None,
        }],
        midi_clips: Vec::new(),
        tempo_events: Vec::new(),
        time_signature_events: Vec::new(),
    };
    let snapshot = compiled_graph_snapshot(&graph, 12);
    assert_eq!(snapshot.graph_revision, 11);
    assert_eq!(snapshot.build_generation, 12);
    assert!(snapshot.nodes.iter().any(|node| {
        node.kind == CompiledGraphNodeKind::InstrumentInput
            && node.signal_width == CompiledGraphSignalWidth::Stereo
    }));
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| node.kind == CompiledGraphNodeKind::BusInput)
    );
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| node.kind == CompiledGraphNodeKind::Master)
    );
    assert!(snapshot.nodes.iter().any(|node| {
        node.plugin_instance_id.as_deref() == Some("active")
            && node.plugin_state == Some(CompiledGraphPluginState::Unavailable)
            && node.label == "Instrument"
    }));
    assert!(
        snapshot
            .edges
            .iter()
            .any(|edge| edge.kind == CompiledGraphEdgeKind::MainRoute)
    );
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| node.kind == CompiledGraphNodeKind::Send && node.label.contains("Post"))
    );
}
