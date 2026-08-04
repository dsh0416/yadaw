use super::*;

#[test]
fn uses_the_driver_default_when_the_range_is_unknown() {
    let selection = select_buffer_size(&SupportedBufferSize::Unknown, 64);
    assert!(matches!(selection.buffer_size, BufferSize::Default));
    assert_eq!(selection.expected_frames, 64);
    assert!(selection.fell_back);
}

#[test]
fn clip_fades_apply_fixed_equal_power_gain_without_state() {
    let clip = LoadedClip {
        channel_index: 0,
        start_frame: 0,
        source_offset_frames: 0,
        length_frames: 8,
        fade_in_frames: 4,
        fade_out_frames: 2,
        samples: ClipSamples::Memory(vec![[1.0, 1.0]; 8]),
    };

    assert_eq!(clip.gain_at(0), 0.0);
    assert!((clip.gain_at(2) - 0.5_f32.sqrt()).abs() < f32::EPSILON);
    assert_eq!(clip.gain_at(4), 1.0);
    assert_eq!(clip.gain_at(6), 1.0);
    assert!((clip.gain_at(7) - 0.5_f32.sqrt()).abs() < f32::EPSILON);
}

#[test]
fn frames_until_timing_boundary_stops_at_tempo_and_signature_changes() {
    let mut runtime = transport_test_runtime(48_000, 100_000, 0, TRANSPORT_STOPPED);
    runtime.tempo_map = TempoMap::new(
        vec![
            TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            },
            TempoEvent {
                tick: 1_920,
                beats_per_minute: 140.0,
            },
        ],
        vec![
            TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            },
            TimeSignatureEvent {
                tick: 3_840,
                numerator: 3,
                denominator: 4,
            },
        ],
    )
    .expect("tempo map");

    let tempo_frame = runtime
        .tempo_map
        .tick_to_frame(1_920, 48_000)
        .expect("tempo frame");
    let signature_frame = runtime
        .tempo_map
        .tick_to_frame(3_840, 48_000)
        .expect("signature frame");

    assert_eq!(
        runtime.frames_until_timing_boundary(0, 200_000),
        tempo_frame as usize
    );
    assert_eq!(
        runtime.frames_until_timing_boundary(tempo_frame, 200_000),
        (signature_frame - tempo_frame) as usize
    );
    assert_eq!(
        runtime.frames_until_timing_boundary(0, 512),
        512,
        "boundaries outside the requested window leave the full maximum"
    );
    assert_eq!(
        runtime.frames_until_timing_boundary(signature_frame, 512),
        512
    );
}

#[test]
fn preview_commands_tolerate_unknown_targets() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 0, TRANSPORT_STOPPED);
    let mut id = [0_u8; 64];
    id[..7].copy_from_slice(b"missing");
    assert!(
        runtime
            .handle_command(EngineCommand::Preview(RealtimeParameterCommand {
                id,
                id_len: 7,
                parameter: RealtimeParameter::ChannelGain,
                value: -6.0,
            }))
            .is_none()
    );
    assert!(
        runtime
            .handle_command(EngineCommand::Preview(RealtimeParameterCommand {
                id,
                id_len: 7,
                parameter: RealtimeParameter::ChannelPan,
                value: 0.25,
            }))
            .is_none()
    );
    assert!(
        runtime
            .handle_command(EngineCommand::Preview(RealtimeParameterCommand {
                id,
                id_len: 7,
                parameter: RealtimeParameter::SendLevel,
                value: -3.0,
            }))
            .is_none()
    );
    assert!(
        runtime
            .handle_command(EngineCommand::Preview(RealtimeParameterCommand {
                id,
                id_len: 7,
                parameter: RealtimeParameter::PluginEnabled,
                value: 0.0,
            }))
            .is_none()
    );
}

#[test]
fn preview_plugin_enabled_switches_the_live_graph_without_rebuilding() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 0, TRANSPORT_STOPPED);
    runtime.plugins_by_channel[0].push(LivePlugin {
        instance_id: "effect".to_owned(),
        processor: None,
        audio_mode: PluginAudioMode::Stereo,
        enabled: true,
        is_instrument: false,
        latency_samples: 0,
        low_latency_bypassed: false,
        main_delay: StereoDelayLine::new(0),
        bypass_delay: StereoDelayLine::new(0),
        aux_inputs: Vec::new(),
    });
    let command = RealtimeParameterCommand::from_preview(NativeMixerParameterPreview {
        target: "plugin".to_owned(),
        id: "effect".to_owned(),
        parameter: "enabled".to_owned(),
        value: 0.0,
    })
    .expect("plugin bypass preview");

    assert!(
        runtime
            .handle_command(EngineCommand::Preview(command))
            .is_none()
    );
    assert!(!runtime.plugins_by_channel[0][0].enabled);
}
