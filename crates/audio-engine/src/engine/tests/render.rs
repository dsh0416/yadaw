use super::*;

#[test]
fn audition_renders_while_stopped_without_moving_the_transport() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 240, TRANSPORT_STOPPED);
    runtime.clips.clear();
    runtime.audition = Some(Box::new(AuditionPlayback {
        frames: vec![[0.25, -0.5], [0.5, -0.25]],
        cursor: 0,
        hardware_outputs: [2, 3],
    }));
    let inputs = [[0.0; MAX_INPUT_CHANNELS]; 2];
    let mut outputs = [[0.0; MAX_OUTPUT_CHANNELS]; 2];

    runtime.render_block(&inputs, &mut outputs, None, None);

    assert_eq!(outputs[0][2..4], [0.25, -0.5]);
    assert_eq!(outputs[1][2..4], [0.5, -0.25]);
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        240
    );
}

#[test]
fn replacing_and_stopping_audition_does_not_change_playback_state() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 10, TRANSPORT_PLAYING);
    runtime.clips.clear();
    runtime.audition = Some(Box::new(AuditionPlayback {
        frames: vec![[0.1, 0.1]],
        cursor: 0,
        hardware_outputs: [0, 1],
    }));
    assert!(
        runtime
            .handle_command(EngineCommand::StartAudition(Box::new(AuditionPlayback {
                frames: vec![[0.75, -0.75]],
                cursor: 0,
                hardware_outputs: [0, 1],
            })))
            .is_none()
    );
    let inputs = [[0.0; MAX_INPUT_CHANNELS]; 1];
    let mut outputs = [[0.0; MAX_OUTPUT_CHANNELS]; 1];

    runtime.render_block(&inputs, &mut outputs, None, None);

    assert_eq!(outputs[0][..2], [0.75, -0.75]);
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
    assert_eq!(
        runtime.transport.position_frames.load(Ordering::Relaxed),
        11
    );
    assert!(
        runtime
            .handle_command(EngineCommand::StopAudition)
            .is_none()
    );
    assert!(runtime.audition.is_none());
    assert_eq!(
        runtime.transport.state.load(Ordering::Relaxed),
        TRANSPORT_PLAYING
    );
}

#[test]
fn application_source_reaches_recording_slots_before_monitoring_is_applied() {
    use ringbuf::traits::{Consumer, Producer};

    let mut runtime = transport_test_runtime(48_000, 1_000, 0, TRANSPORT_RECORDING);
    let (capture, mut producer) =
        crate::application_capture::PreparedApplicationCapture::for_test(48_000)
            .expect("application capture fixture");
    for _ in 0..1_024 {
        producer.try_push([0.25, -0.125]).unwrap();
    }
    runtime.application_captures[0] = Some(capture);
    runtime.recording_routes[0] = Some((0, 2));
    runtime.recording_channel_count = 2;
    runtime.external_source_monitoring[0] = false;
    runtime.clips.clear();
    let (mut tap, mut recorded) = crate::recording::recording_tap_for_test(
        Arc::clone(&runtime.transport.state),
        TRANSPORT_RECORDING,
        2,
    );
    let inputs = [[0.0; MAX_INPUT_CHANNELS]; 512];
    let mut outputs = [[0.0; MAX_OUTPUT_CHANNELS]; 512];

    runtime.render_block(&inputs, &mut outputs, None, Some(&mut tap));

    let captured = std::iter::from_fn(|| recorded.try_pop())
        .any(|frame| (frame[0] - 0.25).abs() < 0.01 && (frame[1] + 0.125).abs() < 0.01);
    assert!(captured, "application frame must be recorded");
    assert!(
        outputs
            .iter()
            .all(|frame| *frame == [0.0; MAX_OUTPUT_CHANNELS])
    );
}

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
