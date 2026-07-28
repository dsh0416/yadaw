fn stopped_snapshot() -> NativeAudioRuntimeSnapshot {
    NativeAudioRuntimeSnapshot {
        state: "stopped".to_owned(),
        requested_buffer_size: None,
        sample_rate: None,
        input_sample_rate: None,
        output_sample_rate: None,
        input_buffer_size: None,
        output_buffer_size: None,
        ring_buffer_capacity_frames: None,
        ring_buffer_fill_frames: None,
        input_latency_ms: None,
        output_latency_ms: None,
        ring_buffer_latency_ms: None,
        engine_latency_ms: None,
        estimated_round_trip_latency_ms: None,
        xruns: 0,
        clock_sync: "inactive".to_owned(),
        buffer_fallback: false,
    }
}

pub fn start_audio_engine(config: NativeAudioEngineConfig) -> Result<NativeAudioRuntimeSnapshot> {
    if config.buffer_size == 0 {
        return Err(invalid_config("buffer size must be greater than zero"));
    }
    if config.session_sample_rate == Some(0) {
        return Err(invalid_config(
            "session sample rate must be greater than zero",
        ));
    }

    let engine_key = AudioEngineKey {
        backend: config.backend.clone(),
        input_device_id: config.input_device_id.clone(),
        output_device_id: config.output_device_id.clone(),
        requested_buffer_size: config.buffer_size,
        requested_session_sample_rate: config.session_sample_rate,
    };

    {
        let guard = engine_slot()
            .lock()
            .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
        if let Some(engine) = guard.as_ref().filter(|engine| engine.matches(&engine_key)) {
            return Ok(engine.metrics.snapshot());
        }
    }

    // Only release devices when the requested configuration genuinely changed.
    *engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))? = None;

    if config.backend == "virtual" {
        if std::env::var_os("YADAW_TEST_VIRTUAL_AUDIO").is_none() {
            return Err(invalid_config(
                "the virtual audio backend is only available in explicit test mode",
            ));
        }
        return start_virtual_audio_engine(engine_key);
    }

    let host = host_for_backend(&config.backend)?;
    let (input_device, output_device) = resolve_stream_devices(
        &config.backend,
        &config.input_device_id,
        &config.output_device_id,
        |id, input| find_device(&host, id, input),
    )?;
    let input_supported = input_device
        .default_input_config()
        .map_err(|error| audio_error("failed to read default input configuration", error))?;
    let output_supported = output_device
        .default_output_config()
        .map_err(|error| audio_error("failed to read default output configuration", error))?;

    let (input_config, input_buffer) = stream_config(&input_supported, config.buffer_size);
    let (output_config, output_buffer) = stream_config(&output_supported, config.buffer_size);
    let session_sample_rate = config
        .session_sample_rate
        .unwrap_or(output_config.sample_rate);
    let bridge_block_size = input_buffer
        .expected_frames
        .max(output_buffer.expected_frames);
    let ring_capacity = (bridge_block_size as usize * RING_BUFFER_BLOCKS).max(256);
    let ring = HeapRb::<InputFrame>::new(ring_capacity);
    let (mut producer, consumer) = ring.split();
    for _ in 0..bridge_block_size {
        producer
            .try_push([0.0; MAX_INPUT_CHANNELS])
            .map_err(|_| audio_error("failed to prime ring buffer", "buffer is full"))?;
    }
    let metrics = Arc::new(RuntimeMetrics {
        requested_buffer_size: config.buffer_size,
        sample_rate: session_sample_rate,
        input_sample_rate: input_config.sample_rate,
        output_sample_rate: output_config.sample_rate,
        input_buffer_size: AtomicU32::new(input_buffer.expected_frames),
        output_buffer_size: AtomicU32::new(output_buffer.expected_frames),
        ring_buffer_capacity_frames: ring_capacity as u32,
        ring_buffer_fill_frames: AtomicU32::new(bridge_block_size),
        input_latency_us: AtomicU64::new(UNKNOWN_LATENCY_US),
        output_latency_us: AtomicU64::new(UNKNOWN_LATENCY_US),
        engine_latency_us: AtomicU64::new(0),
        xruns: AtomicU32::new(0),
        callback_generation: AtomicU64::new(0),
        published_graph_generation: AtomicU64::new(0),
        published_graph_build_generation: AtomicU64::new(0),
        faulted: AtomicBool::new(false),
        buffer_fallback: AtomicBool::new(input_buffer.fell_back || output_buffer.fell_back),
        clock_sync: if config.input_device_id == config.output_device_id
            && input_config.sample_rate == output_config.sample_rate
        {
            "shared-device"
        } else {
            "adaptive-resampled"
        },
    });
    let round_trip_latency = Arc::new(RoundTripLatencyMeasurement::new(
        u32::from(input_config.channels).min(MAX_INPUT_CHANNELS as u32),
        u32::from(output_config.channels).min(MAX_OUTPUT_CHANNELS as u32),
        input_config.sample_rate,
    ));
    let (recorder, recording_tap) =
        RecorderController::new(input_config.sample_rate, usize::from(input_config.channels));
    let initial_mixer = take_pending_mixer(session_sample_rate)?;
    if let Some(runtime) = initial_mixer.as_ref() {
        metrics
            .published_graph_generation
            .store(runtime.generation, Ordering::Release);
        metrics
            .published_graph_build_generation
            .store(runtime.build_generation, Ordering::Release);
    }
    let transport = initial_mixer.as_ref().map_or_else(
        || {
            Arc::new(TransportShared {
                state: AtomicU32::new(TRANSPORT_STOPPED),
                position_frames: AtomicU64::new(0),
                sample_rate: AtomicU32::new(session_sample_rate),
            })
        },
        |runtime| Arc::clone(&runtime.transport),
    );
    let meter_bank = initial_mixer.as_ref().map_or_else(
        || Arc::new(MeterBank { channels: vec![] }),
        |runtime| Arc::clone(&runtime.meter_bank),
    );
    let input_peaks = initial_mixer.as_ref().map_or_else(
        || Arc::new(InputPeakBank::new()),
        |runtime| Arc::clone(&runtime.input_peaks),
    );
    let command_ring = HeapRb::<EngineCommand>::new(ENGINE_COMMAND_CAPACITY);
    let (commands, command_consumer) = command_ring.split();
    let retirement_ring = HeapRb::<Box<NativeMixerRuntime>>::new(ENGINE_COMMAND_CAPACITY);
    let (retirement_producer, retired_mixers) = retirement_ring.split();

    let input_stream = build_stream_for_format!(
        build_input_stream,
        input_supported.sample_format(),
        &input_device,
        &input_config,
        producer,
        Arc::clone(&metrics),
        recording_tap,
        Arc::clone(&input_peaks),
        Arc::clone(&round_trip_latency),
    )?;
    let output_stream = build_stream_for_format!(
        build_output_stream,
        output_supported.sample_format(),
        &output_device,
        &output_config,
        consumer,
        usize::from(input_config.channels),
        bridge_block_size as usize,
        OutputStreamContext {
            metrics: Arc::clone(&metrics),
            mixer_control: OutputMixerControl {
                commands: command_consumer,
                mixer: initial_mixer,
                retired_mixers: retirement_producer,
            },
            round_trip_latency: Arc::clone(&round_trip_latency),
        },
    )?;

    let actual_input_buffer = input_stream
        .buffer_size()
        .unwrap_or(input_buffer.expected_frames);
    let actual_output_buffer = output_stream
        .buffer_size()
        .unwrap_or(output_buffer.expected_frames);
    metrics
        .input_buffer_size
        .store(actual_input_buffer, Ordering::Relaxed);
    metrics
        .output_buffer_size
        .store(actual_output_buffer, Ordering::Relaxed);
    if actual_input_buffer != config.buffer_size || actual_output_buffer != config.buffer_size {
        metrics.buffer_fallback.store(true, Ordering::Relaxed);
    }

    input_stream
        .play()
        .map_err(|error| audio_error("failed to start cpal input stream", error))?;
    output_stream
        .play()
        .map_err(|error| audio_error("failed to start cpal output stream", error))?;

    let engine = AudioEngine {
        _input_stream: Some(input_stream),
        _output_stream: Some(output_stream),
        _virtual_thread: None,
        metrics,
        key: engine_key,
        recorder,
        commands,
        retired_mixers,
        meter_bank,
        transport,
        input_peaks,
        round_trip_latency,
    };
    let snapshot = engine.metrics.snapshot();
    *engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))? = Some(engine);

    Ok(snapshot)
}

fn start_virtual_audio_engine(key: AudioEngineKey) -> Result<NativeAudioRuntimeSnapshot> {
    let input_sample_rate = 48_000;
    let output_sample_rate = 48_000;
    let sample_rate = key
        .requested_session_sample_rate
        .unwrap_or(output_sample_rate);
    let block_frames = key.requested_buffer_size.clamp(32, 2_048);
    let metrics = Arc::new(RuntimeMetrics {
        requested_buffer_size: key.requested_buffer_size,
        sample_rate,
        input_sample_rate,
        output_sample_rate,
        input_buffer_size: AtomicU32::new(block_frames),
        output_buffer_size: AtomicU32::new(block_frames),
        ring_buffer_capacity_frames: (block_frames * RING_BUFFER_BLOCKS as u32).max(256),
        ring_buffer_fill_frames: AtomicU32::new(block_frames),
        input_latency_us: AtomicU64::new(0),
        output_latency_us: AtomicU64::new(0),
        engine_latency_us: AtomicU64::new(0),
        xruns: AtomicU32::new(0),
        callback_generation: AtomicU64::new(0),
        published_graph_generation: AtomicU64::new(0),
        published_graph_build_generation: AtomicU64::new(0),
        faulted: AtomicBool::new(false),
        buffer_fallback: AtomicBool::new(false),
        clock_sync: "shared-device",
    });
    let round_trip_latency = Arc::new(RoundTripLatencyMeasurement::new(2, 2, input_sample_rate));
    let (recorder, _recording_tap) = RecorderController::new(sample_rate, 2);
    let initial_mixer = take_pending_mixer(sample_rate)?;
    if let Some(runtime) = initial_mixer.as_ref() {
        metrics
            .published_graph_generation
            .store(runtime.generation, Ordering::Release);
        metrics
            .published_graph_build_generation
            .store(runtime.build_generation, Ordering::Release);
    }
    let transport = initial_mixer.as_ref().map_or_else(
        || {
            Arc::new(TransportShared {
                state: AtomicU32::new(TRANSPORT_STOPPED),
                position_frames: AtomicU64::new(0),
                sample_rate: AtomicU32::new(sample_rate),
            })
        },
        |runtime| Arc::clone(&runtime.transport),
    );
    let meter_bank = initial_mixer.as_ref().map_or_else(
        || Arc::new(MeterBank { channels: vec![] }),
        |runtime| Arc::clone(&runtime.meter_bank),
    );
    let input_peaks = initial_mixer.as_ref().map_or_else(
        || Arc::new(InputPeakBank::new()),
        |runtime| Arc::clone(&runtime.input_peaks),
    );
    let command_ring = HeapRb::<EngineCommand>::new(ENGINE_COMMAND_CAPACITY);
    let (commands, mut command_consumer) = command_ring.split();
    let retirement_ring = HeapRb::<Box<NativeMixerRuntime>>::new(ENGINE_COMMAND_CAPACITY);
    let (mut retirement_producer, retired_mixers) = retirement_ring.split();
    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_shutdown = Arc::clone(&shutdown);
    let worker_metrics = Arc::clone(&metrics);
    let worker_round_trip_latency = Arc::clone(&round_trip_latency);
    let input_ring = HeapRb::<InputFrame>::new(worker_metrics.ring_buffer_capacity_frames as usize);
    let (mut input_producer, input_consumer) = input_ring.split();
    for _ in 0..block_frames {
        input_producer
            .try_push([0.0; MAX_INPUT_CHANNELS])
            .map_err(|_| audio_error("failed to prime virtual input ring", "buffer is full"))?;
    }
    let mut input_resampler = AdaptiveResampler::new(
        input_consumer,
        input_sample_rate,
        sample_rate,
        2,
        block_frames as usize,
        worker_metrics.ring_buffer_capacity_frames as usize,
    )?;
    let mut output_converter = SessionOutputConverter::new(sample_rate, output_sample_rate, 2)?;
    worker_metrics.engine_latency_us.store(
        frames_to_micros(input_resampler.output_delay(), sample_rate).saturating_add(
            frames_to_micros(output_converter.output_delay(), output_sample_rate),
        ),
        Ordering::Relaxed,
    );
    let thread = thread::Builder::new()
        .name("yadaw-virtual-audio".to_owned())
        .spawn(move || {
            let mut mixer = initial_mixer;
            let mut round_trip_detector =
                RoundTripInputDetector::new(Arc::clone(&worker_round_trip_latency));
            let mut round_trip_probe =
                RoundTripOutputProbe::new(Arc::clone(&worker_round_trip_latency));
            let mut loopback_block = vec![[0.0_f32; MAX_INPUT_CHANNELS]; block_frames as usize];
            let block_duration =
                Duration::from_secs_f64(block_frames as f64 / output_sample_rate as f64);
            while !worker_shutdown.load(Ordering::Acquire) {
                let input_callback_started_ns = worker_round_trip_latency.now_ns();
                let mut overrun = false;
                for (frame_index, capture) in loopback_block.iter().enumerate() {
                    round_trip_detector.observe(
                        &capture[..2],
                        input_callback_started_ns
                            .saturating_add(frames_to_nanos(frame_index, input_sample_rate)),
                    );
                    if input_producer.try_push(*capture).is_err() {
                        overrun = true;
                    }
                }
                loopback_block.fill([0.0; MAX_INPUT_CHANNELS]);
                while let Some(command) = command_consumer.try_pop() {
                    if let Some(runtime) = mixer.as_mut() {
                        if let Some(replacement) = runtime.handle_command(command) {
                            worker_metrics
                                .published_graph_generation
                                .store(replacement.generation, Ordering::Release);
                            worker_metrics
                                .published_graph_build_generation
                                .store(replacement.build_generation, Ordering::Release);
                            if let Some(retired) = mixer.replace(replacement)
                                && let Err(retired) = retirement_producer.try_push(retired)
                            {
                                std::mem::forget(retired);
                            }
                        }
                    } else if let EngineCommand::LoadMixer(runtime) = command {
                        worker_metrics
                            .published_graph_generation
                            .store(runtime.generation, Ordering::Release);
                        worker_metrics
                            .published_graph_build_generation
                            .store(runtime.build_generation, Ordering::Release);
                        mixer = Some(runtime);
                    }
                }
                let mut rendered_session_frames = 0;
                let mut underrun = false;
                let output_callback_started_ns = worker_round_trip_latency.now_ns();
                for (frame_index, loopback) in loopback_block.iter_mut().enumerate() {
                    let (mut output, frame_underrun, rendered_frames) = output_converter
                        .next_frame(|| {
                            let (input, input_underrun) = input_resampler.next_frame();
                            let (output, render_underrun) = mixer
                                .as_mut()
                                .map_or(([0.0; MAX_OUTPUT_CHANNELS], false), |runtime| {
                                    runtime.render_frame(input)
                                });
                            (output, input_underrun || render_underrun)
                        });
                    round_trip_probe.apply(
                        &mut output[..2],
                        output_callback_started_ns
                            .saturating_add(frames_to_nanos(frame_index, output_sample_rate)),
                    );
                    let input_channel = worker_round_trip_latency
                        .input_channel
                        .load(Ordering::Relaxed) as usize;
                    let output_channel = worker_round_trip_latency
                        .output_channel
                        .load(Ordering::Relaxed) as usize;
                    if let (Some(capture), Some(sample)) =
                        (loopback.get_mut(input_channel), output.get(output_channel))
                    {
                        *capture = *sample;
                    }
                    underrun |= frame_underrun;
                    rendered_session_frames += rendered_frames;
                }
                if let Some(runtime) = mixer.as_mut() {
                    runtime.publish_peaks(rendered_session_frames);
                }
                worker_metrics
                    .ring_buffer_fill_frames
                    .store(input_resampler.occupied_len() as u32, Ordering::Relaxed);
                if overrun || underrun {
                    worker_metrics.xruns.fetch_add(1, Ordering::Relaxed);
                }
                worker_metrics
                    .callback_generation
                    .fetch_add(1, Ordering::Release);
                thread::sleep(block_duration);
            }
        })
        .map_err(|error| audio_error("failed to start virtual audio thread", error))?;
    let engine = AudioEngine {
        _input_stream: None,
        _output_stream: None,
        _virtual_thread: Some(VirtualAudioThread {
            shutdown,
            thread: Some(thread),
        }),
        metrics,
        key,
        recorder,
        commands,
        retired_mixers,
        meter_bank,
        transport,
        input_peaks,
        round_trip_latency,
    };
    let snapshot = engine.metrics.snapshot();
    *engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))? = Some(engine);
    Ok(snapshot)
}

pub fn stop_audio_engine() -> Result<NativeAudioRuntimeSnapshot> {
    *engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))? = None;
    Ok(stopped_snapshot())
}

pub fn audio_engine_snapshot() -> Result<NativeAudioRuntimeSnapshot> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    Ok(guard
        .as_ref()
        .map_or_else(stopped_snapshot, |engine| engine.metrics.snapshot()))
}

pub fn start_round_trip_latency_measurement(
    request: NativeRoundTripLatencyMeasurementRequest,
) -> Result<NativeRoundTripLatencyMeasurementSnapshot> {
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("the audio engine must be running"))?;
    if engine.transport.state.load(Ordering::Acquire) != TRANSPORT_STOPPED {
        return Err(invalid_config(
            "stop transport before measuring round-trip latency",
        ));
    }
    engine.round_trip_latency.start(request)?;
    Ok(engine.round_trip_latency.snapshot())
}

pub fn round_trip_latency_measurement_snapshot() -> Result<NativeRoundTripLatencyMeasurementSnapshot>
{
    let guard = engine_slot()
        .lock()
        .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| invalid_config("the audio engine must be running"))?;
    Ok(engine.round_trip_latency.snapshot())
}
