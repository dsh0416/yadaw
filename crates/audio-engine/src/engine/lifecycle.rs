use super::{
    Arc, AtomicBool, AtomicU32, AtomicU64, AudioEngine, AudioEngineKey, DeviceTrait,
    ENGINE_COMMAND_CAPACITY, EngineCommand, HeapRb, InputFrame, InputPeakBank, MAX_INPUT_CHANNELS,
    MAX_OUTPUT_CHANNELS, MeterBank, NativeAudioEngineConfig, NativeAudioRuntimeSnapshot,
    NativeMixerRuntime, NativeRoundTripLatencyMeasurementRequest,
    NativeRoundTripLatencyMeasurementSnapshot, Ordering, OutputMixerControl, OutputStreamContext,
    Producer, RING_BUFFER_BLOCKS, RecorderController, Result, RoundTripLatencyMeasurement,
    RunningAudioEngine, RuntimeMetrics, SampleFormat, Split, StreamTrait, TRANSPORT_RECORDING,
    TRANSPORT_STOPPED, TransportShared, UNKNOWN_LATENCY_US, audio_error, build_input_stream,
    build_output_stream, build_stream_for_format, find_device, invalid_config,
    resolve_stream_devices, stream_config, take_pending_mixer,
};

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

impl AudioEngine {
    pub fn start_audio_engine(
        &self,
        config: NativeAudioEngineConfig,
    ) -> Result<NativeAudioRuntimeSnapshot> {
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
        // Keep pending -> starting -> running ownership transfer atomic to control
        // commands. Otherwise a preview can observe neither runtime and be lost.
        let _transition = self
            .runtime_transition
            .lock()
            .map_err(|_| audio_error("audio runtime transition lock", "poisoned"))?;

        {
            let guard = self
                .running
                .lock()
                .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
            if let Some(engine) = guard.as_ref().filter(|engine| engine.matches(&engine_key)) {
                return Ok(engine.metrics.snapshot());
            }
        }

        // Only release devices when the requested configuration genuinely changed. Drop the CPAL
        // streams after releasing the state lock: some platform drivers synchronously wait while a
        // stream is destroyed, and liveness/snapshot reads must not queue behind that wait.
        let previous = self
            .running
            .lock()
            .map_err(|_| audio_error("audio engine lock", "poisoned"))?
            .take();
        drop(previous);

        let host = crate::device::host_for_backend(&config.backend)?;
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
        let initial_mixer = take_pending_mixer(self, session_sample_rate)?;
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
                    state: Arc::new(AtomicU32::new(TRANSPORT_STOPPED)),
                    position_frames: Arc::new(AtomicU64::new(0)),
                    position_ticks: Arc::new(AtomicU64::new(0)),
                    sample_rate: AtomicU32::new(session_sample_rate),
                    effective_bpm_bits: AtomicU64::new(f64::NAN.to_bits()),
                    clock_source: AtomicU32::new(0),
                    waiting_for: AtomicU32::new(0),
                    loop_enabled: AtomicBool::new(false),
                    loop_has_range: AtomicBool::new(false),
                    loop_start_tick: AtomicU64::new(0),
                    loop_end_tick: AtomicU64::new(0),
                })
            },
            |runtime| Arc::clone(&runtime.transport),
        );
        let (recorder, recording_tap) = RecorderController::new(
            session_sample_rate,
            Arc::clone(&transport.state),
            TRANSPORT_RECORDING,
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
                recording_tap,
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

        let engine = RunningAudioEngine {
            _input_stream: input_stream,
            _output_stream: output_stream,
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
        *self
            .running
            .lock()
            .map_err(|_| audio_error("audio engine lock", "poisoned"))? = Some(engine);

        Ok(snapshot)
    }

    pub fn stop_audio_engine(&self) -> Result<NativeAudioRuntimeSnapshot> {
        let _transition = self
            .runtime_transition
            .lock()
            .map_err(|_| audio_error("audio runtime transition lock", "poisoned"))?;
        // Destroy streams outside the state lock. In particular, an ASIO driver may block while its
        // stream is torn down; heartbeat must remain able to observe the transition in that case.
        let previous = self
            .running
            .lock()
            .map_err(|_| audio_error("audio engine lock", "poisoned"))?
            .take();
        drop(previous);
        Ok(stopped_snapshot())
    }

    pub fn audio_engine_snapshot(&self) -> Result<NativeAudioRuntimeSnapshot> {
        let guard = self
            .running
            .lock()
            .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
        Ok(guard
            .as_ref()
            .map_or_else(stopped_snapshot, |engine| engine.metrics.snapshot()))
    }

    pub fn start_round_trip_latency_measurement(
        &self,
        request: NativeRoundTripLatencyMeasurementRequest,
    ) -> Result<NativeRoundTripLatencyMeasurementSnapshot> {
        let guard = self
            .running
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

    pub fn round_trip_latency_measurement_snapshot(
        &self,
    ) -> Result<NativeRoundTripLatencyMeasurementSnapshot> {
        let guard = self
            .running
            .lock()
            .map_err(|_| audio_error("audio engine lock", "poisoned"))?;
        let engine = guard
            .as_ref()
            .ok_or_else(|| invalid_config("the audio engine must be running"))?;
        Ok(engine.round_trip_latency.snapshot())
    }
}
