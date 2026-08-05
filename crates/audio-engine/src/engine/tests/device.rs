use super::*;

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
fn clamps_a_request_outside_the_device_range_to_a_fixed_supported_size() {
    // The clamped size must be requested rather than the driver default, so
    // that the ring buffer and resamplers are sized for the block size the
    // callbacks actually receive.
    assert_fixed(
        select_buffer_size(&SupportedBufferSize::Range { min: 480, max: 480 }, 64),
        480,
        true,
    );
    assert_fixed(
        select_buffer_size(&SupportedBufferSize::Range { min: 32, max: 512 }, 1_024),
        512,
        true,
    );
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
fn heartbeat_does_not_wait_for_the_audio_runtime_lock() {
    let engine = AudioEngine::new();
    let runtime = engine.running.lock().expect("audio runtime lock");

    assert_eq!(engine.heartbeat_snapshot(), (0, "transitioning".to_owned()));

    drop(runtime);
    assert_eq!(engine.heartbeat_snapshot(), (0, "stopped".to_owned()));
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
    let mut converter = SessionOutputConverter::new(44_100, 48_000, MAX_OUTPUT_CHANNELS).unwrap();
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
    let (input, output) = resolve_stream_devices("asio", "us-1x2hr", "us-1x2hr", |id, input| {
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
fn streaming_clip_prefetches_and_restarts_after_a_seek_generation() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "heron-streaming-{}-{nonce}.bwf",
        std::process::id()
    ));
    write_deterministic_test_recording(
        NativeRecordingStartConfig {
            path: path.to_string_lossy().into_owned(),
            asset_id: "streaming-test".to_owned(),
            originator: "Heron test".to_owned(),
            origination_date: "2026-07-24".to_owned(),
            origination_time: "12:00:00".to_owned(),
            time_reference: 0,
            sample_rate: 48_000,
            channels: 2,
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

#[test]
fn frames_to_nanos_scales_with_sample_rate() {
    assert_eq!(frames_to_nanos(48_000, 48_000), 1_000_000_000);
    assert_eq!(frames_to_nanos(24_000, 48_000), 500_000_000);
    assert_eq!(frames_to_nanos(0, 48_000), 0);
}

#[test]
fn build_mixer_runtime_rejects_zero_sample_rate() {
    let mut graph = simple_native_graph();
    graph.sample_rate = 0;
    assert_build_err(
        build_mixer_runtime(
            graph,
            1,
            test_transport(48_000),
            Arc::new(InputPeakBank::new()),
        ),
        "sample rate must be positive",
    );
}

#[test]
fn build_mixer_runtime_rejects_invalid_armed_input_mapping() {
    let mut graph = simple_native_graph();
    graph.channels[0].record_armed = true;
    graph.channels[0].input_monitoring = false;
    graph.channels[0].input_source = Some("hardware".into());
    graph.channels[0].input_channels = vec![];
    assert_build_err(
        build_mixer_runtime(
            graph,
            1,
            test_transport(48_000),
            Arc::new(InputPeakBank::new()),
        ),
        "armed track has an invalid input mapping",
    );
}

#[test]
fn build_mixer_runtime_rejects_invalid_monitor_input_mapping() {
    let mut graph = simple_native_graph();
    graph.channels[0].input_monitoring = true;
    graph.channels[0].input_source = Some("hardware".into());
    graph.channels[0].input_channels = vec![1, 2, 3];
    assert_build_err(
        build_mixer_runtime(
            graph,
            1,
            test_transport(48_000),
            Arc::new(InputPeakBank::new()),
        ),
        "monitored track has an invalid input mapping",
    );
}

#[test]
fn render_block_rejects_mismatched_buffers_and_silence_when_stopped() {
    let mut runtime = transport_test_runtime(48_000, 1_000, 0, TRANSPORT_STOPPED);
    let inputs = vec![[0.5; MAX_INPUT_CHANNELS]; 8];
    let mut outputs = vec![[0.25; MAX_OUTPUT_CHANNELS]; 4];
    assert!(runtime.render_block(&inputs, &mut outputs, None, None));
    assert!(
        outputs
            .iter()
            .all(|frame| frame.iter().all(|sample| *sample == 0.0))
    );

    let inputs = vec![[0.5; MAX_INPUT_CHANNELS]; 16];
    let mut outputs = vec![[0.25; MAX_OUTPUT_CHANNELS]; 16];
    assert!(!runtime.render_block(&inputs, &mut outputs, None, None));
    assert!(
        outputs
            .iter()
            .all(|frame| frame.iter().all(|sample| *sample == 0.0))
    );
}
