struct NativeMixerRuntime {
    generation: u64,
    build_generation: u64,
    graph: MixerGraph,
    clips: Vec<LoadedClip>,
    channel_sources: Vec<StereoFrame>,
    channel_input_widths: Vec<SignalWidth>,
    plugins_by_channel: Vec<Vec<LivePlugin>>,
    midi_events: Vec<ScheduledMidiEvent>,
    midi_cursor: usize,
    active_notes: Vec<bool>,
    metronome: MetronomeScheduler,
    tempo_map: TempoMap,
    peak_scratch: Vec<ChannelPeak>,
    held_peaks: Vec<StereoFrame>,
    held_until: Vec<[u64; 2]>,
    meter_bank: Arc<MeterBank>,
    transport: Arc<TransportShared>,
    sample_rate: u32,
    content_end_frame: u64,
    tail_end_frame: Option<u64>,
    has_infinite_tail: bool,
    input_peaks: Arc<InputPeakBank>,
    input_meter_routes: Vec<Option<[usize; 2]>>,
    monitor_input_routes: Vec<Option<[usize; 2]>>,
    input_peak_scratch: [f32; MAX_INPUT_CHANNELS],
    meter_frame_clock: u64,
}

#[derive(Clone, Copy)]
enum RealtimeParameter {
    ChannelGain,
    ChannelPan,
    SendLevel,
}

#[derive(Clone, Copy)]
struct RealtimeParameterCommand {
    id: [u8; 64],
    id_len: u8,
    parameter: RealtimeParameter,
    value: f32,
}

impl RealtimeParameterCommand {
    fn from_preview(preview: NativeMixerParameterPreview) -> Result<Self> {
        let parameter = match (preview.target.as_str(), preview.parameter.as_str()) {
            ("channel", "gainDb") => RealtimeParameter::ChannelGain,
            ("channel", "pan") => RealtimeParameter::ChannelPan,
            ("send", "levelDb") => RealtimeParameter::SendLevel,
            _ => return Err(invalid_config("unknown mixer preview parameter")),
        };
        let bytes = preview.id.as_bytes();
        if bytes.len() > 64 {
            return Err(invalid_config("mixer identifier is too long"));
        }
        let mut id = [0_u8; 64];
        id[..bytes.len()].copy_from_slice(bytes);
        Ok(Self {
            id,
            id_len: bytes.len() as u8,
            parameter,
            value: preview.value as f32,
        })
    }

    fn id(&self) -> &str {
        std::str::from_utf8(&self.id[..usize::from(self.id_len)]).unwrap_or("")
    }
}

#[derive(Clone, Copy)]
enum TransportAction {
    Play,
    Pause,
    Stop,
    Seek,
    Record,
}

enum EngineCommand {
    LoadMixer(Box<NativeMixerRuntime>),
    Preview(RealtimeParameterCommand),
    Transport(TransportAction, u64),
    ClearMeterClips,
}

struct RoundTripLatencyMeasurement {
    clock_origin: Instant,
    state: AtomicU32,
    generation: AtomicU64,
    input_channel: AtomicU32,
    output_channel: AtomicU32,
    started_at_ns: AtomicU64,
    emitted_at_ns: AtomicU64,
    latency_ns: AtomicU64,
    input_channels: u32,
    output_channels: u32,
    input_sample_rate: u32,
}

impl RoundTripLatencyMeasurement {
    fn new(input_channels: u32, output_channels: u32, input_sample_rate: u32) -> Self {
        Self {
            clock_origin: Instant::now(),
            state: AtomicU32::new(LOOPBACK_MEASUREMENT_IDLE),
            generation: AtomicU64::new(0),
            input_channel: AtomicU32::new(0),
            output_channel: AtomicU32::new(0),
            started_at_ns: AtomicU64::new(0),
            emitted_at_ns: AtomicU64::new(0),
            latency_ns: AtomicU64::new(0),
            input_channels,
            output_channels,
            input_sample_rate,
        }
    }

    fn now_ns(&self) -> u64 {
        self.clock_origin
            .elapsed()
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64
    }

    fn start(&self, request: NativeRoundTripLatencyMeasurementRequest) -> Result<()> {
        if request.input_channel == 0 || request.input_channel > self.input_channels {
            return Err(invalid_config(format!(
                "loopback input channel must be between 1 and {}",
                self.input_channels
            )));
        }
        if request.output_channel == 0 || request.output_channel > self.output_channels {
            return Err(invalid_config(format!(
                "loopback output channel must be between 1 and {}",
                self.output_channels
            )));
        }
        if matches!(
            self.state.load(Ordering::Acquire),
            LOOPBACK_MEASUREMENT_PREPARING
                | LOOPBACK_MEASUREMENT_READY
                | LOOPBACK_MEASUREMENT_RUNNING
        ) {
            return Err(invalid_config(
                "a round-trip latency measurement is already running",
            ));
        }

        self.input_channel
            .store(request.input_channel - 1, Ordering::Relaxed);
        self.output_channel
            .store(request.output_channel - 1, Ordering::Relaxed);
        self.started_at_ns.store(self.now_ns(), Ordering::Relaxed);
        self.emitted_at_ns.store(0, Ordering::Relaxed);
        self.latency_ns.store(0, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.state
            .store(LOOPBACK_MEASUREMENT_PREPARING, Ordering::Release);
        Ok(())
    }

    fn expire_if_needed(&self, now_ns: u64) {
        let state = self.state.load(Ordering::Acquire);
        if !matches!(
            state,
            LOOPBACK_MEASUREMENT_PREPARING
                | LOOPBACK_MEASUREMENT_READY
                | LOOPBACK_MEASUREMENT_RUNNING
        ) {
            return;
        }
        let started_at = self.started_at_ns.load(Ordering::Relaxed);
        if now_ns.saturating_sub(started_at) >= LOOPBACK_MEASUREMENT_TIMEOUT_NS {
            let _ = self.state.compare_exchange(
                state,
                LOOPBACK_MEASUREMENT_SIGNAL_NOT_DETECTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }

    fn snapshot(&self) -> NativeRoundTripLatencyMeasurementSnapshot {
        self.expire_if_needed(self.now_ns());
        let state = self.state.load(Ordering::Acquire);
        let has_selection = state != LOOPBACK_MEASUREMENT_IDLE;
        let latency_ns = self.latency_ns.load(Ordering::Acquire);
        NativeRoundTripLatencyMeasurementSnapshot {
            status: match state {
                LOOPBACK_MEASUREMENT_PREPARING | LOOPBACK_MEASUREMENT_READY => "preparing",
                LOOPBACK_MEASUREMENT_RUNNING => "measuring",
                LOOPBACK_MEASUREMENT_COMPLETE => "complete",
                LOOPBACK_MEASUREMENT_INPUT_TOO_LOUD | LOOPBACK_MEASUREMENT_SIGNAL_NOT_DETECTED => {
                    "failed"
                }
                _ => "idle",
            }
            .to_owned(),
            input_channel: has_selection.then(|| self.input_channel.load(Ordering::Relaxed) + 1),
            output_channel: has_selection.then(|| self.output_channel.load(Ordering::Relaxed) + 1),
            measured_round_trip_latency_ms: (state == LOOPBACK_MEASUREMENT_COMPLETE)
                .then_some(latency_ns as f64 / 1_000_000.0),
            failure: match state {
                LOOPBACK_MEASUREMENT_INPUT_TOO_LOUD => Some("input-too-loud".to_owned()),
                LOOPBACK_MEASUREMENT_SIGNAL_NOT_DETECTED => Some("signal-not-detected".to_owned()),
                _ => None,
            },
        }
    }
}

struct RoundTripInputDetector {
    shared: Arc<RoundTripLatencyMeasurement>,
    generation: u64,
    quiet_frames: u32,
    quiet_peak: f32,
    history: [f32; LOOPBACK_PROBE.len()],
    history_length: usize,
}

impl RoundTripInputDetector {
    fn new(shared: Arc<RoundTripLatencyMeasurement>) -> Self {
        Self {
            shared,
            generation: 0,
            quiet_frames: 0,
            quiet_peak: 0.0,
            history: [0.0; LOOPBACK_PROBE.len()],
            history_length: 0,
        }
    }

    fn reset_for_generation(&mut self, generation: u64) {
        self.generation = generation;
        self.quiet_frames = 0;
        self.quiet_peak = 0.0;
        self.history.fill(0.0);
        self.history_length = 0;
    }

    fn observe(&mut self, frame: &[f32], frame_time_ns: u64) {
        let generation = self.shared.generation.load(Ordering::Acquire);
        if generation != self.generation {
            self.reset_for_generation(generation);
        }
        self.shared.expire_if_needed(frame_time_ns);
        let state = self.shared.state.load(Ordering::Acquire);
        let input_channel = self.shared.input_channel.load(Ordering::Relaxed) as usize;
        let sample = frame.get(input_channel).copied().unwrap_or(0.0);

        if state == LOOPBACK_MEASUREMENT_PREPARING {
            self.quiet_frames = self.quiet_frames.saturating_add(1);
            self.quiet_peak = self.quiet_peak.max(sample.abs());
            let required_frames = u64::from(self.shared.input_sample_rate)
                .saturating_mul(LOOPBACK_QUIET_DURATION_MS)
                / 1_000;
            if u64::from(self.quiet_frames) >= required_frames {
                let next_state = if self.quiet_peak <= LOOPBACK_QUIET_THRESHOLD {
                    LOOPBACK_MEASUREMENT_READY
                } else {
                    LOOPBACK_MEASUREMENT_INPUT_TOO_LOUD
                };
                let _ = self.shared.state.compare_exchange(
                    LOOPBACK_MEASUREMENT_PREPARING,
                    next_state,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
            }
            return;
        }
        if state != LOOPBACK_MEASUREMENT_RUNNING {
            return;
        }

        self.history.copy_within(1.., 0);
        self.history[LOOPBACK_PROBE.len() - 1] = sample;
        self.history_length = (self.history_length + 1).min(LOOPBACK_PROBE.len());
        if self.history_length < LOOPBACK_PROBE.len() {
            return;
        }

        let mut dot = 0.0_f32;
        let mut energy = 0.0_f32;
        for (captured, expected) in self.history.iter().zip(LOOPBACK_PROBE) {
            dot += captured * expected;
            energy += captured * captured;
        }
        if energy < LOOPBACK_MINIMUM_SIGNAL_ENERGY {
            return;
        }
        let probe_energy = LOOPBACK_PROBE.len() as f32;
        let correlation = dot.abs() / (energy * probe_energy).sqrt();
        if correlation < LOOPBACK_CORRELATION_THRESHOLD {
            return;
        }

        let probe_duration_ns = frames_to_nanos(
            LOOPBACK_PROBE.len().saturating_sub(1),
            self.shared.input_sample_rate,
        );
        let detected_at_ns = frame_time_ns.saturating_sub(probe_duration_ns);
        let emitted_at_ns = self.shared.emitted_at_ns.load(Ordering::Acquire);
        if detected_at_ns <= emitted_at_ns {
            return;
        }
        self.shared
            .latency_ns
            .store(detected_at_ns - emitted_at_ns, Ordering::Release);
        let _ = self.shared.state.compare_exchange(
            LOOPBACK_MEASUREMENT_RUNNING,
            LOOPBACK_MEASUREMENT_COMPLETE,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

struct RoundTripOutputProbe {
    shared: Arc<RoundTripLatencyMeasurement>,
    generation: u64,
    cursor: usize,
}

impl RoundTripOutputProbe {
    fn new(shared: Arc<RoundTripLatencyMeasurement>) -> Self {
        Self {
            shared,
            generation: 0,
            cursor: LOOPBACK_PROBE.len(),
        }
    }

    fn apply(&mut self, frame: &mut [f32], frame_time_ns: u64) {
        let generation = self.shared.generation.load(Ordering::Acquire);
        if generation != self.generation {
            self.generation = generation;
            self.cursor = LOOPBACK_PROBE.len();
        }
        self.shared.expire_if_needed(frame_time_ns);
        let mut state = self.shared.state.load(Ordering::Acquire);
        let output_channel = self.shared.output_channel.load(Ordering::Relaxed) as usize;
        if matches!(
            state,
            LOOPBACK_MEASUREMENT_PREPARING
                | LOOPBACK_MEASUREMENT_READY
                | LOOPBACK_MEASUREMENT_RUNNING
        ) && let Some(sample) = frame.get_mut(output_channel)
        {
            // Silence the selected graph output for the short measurement window.
            // This prevents existing monitoring routes from forming a feedback loop
            // through the physical cable.
            *sample = 0.0;
        }
        if state == LOOPBACK_MEASUREMENT_READY {
            self.shared
                .emitted_at_ns
                .store(frame_time_ns, Ordering::Release);
            self.cursor = 0;
            if self
                .shared
                .state
                .compare_exchange(
                    LOOPBACK_MEASUREMENT_READY,
                    LOOPBACK_MEASUREMENT_RUNNING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                state = LOOPBACK_MEASUREMENT_RUNNING;
            }
        }
        if state != LOOPBACK_MEASUREMENT_RUNNING || self.cursor >= LOOPBACK_PROBE.len() {
            return;
        }
        if let Some(sample) = frame.get_mut(output_channel) {
            *sample = LOOPBACK_PROBE[self.cursor] * LOOPBACK_PROBE_AMPLITUDE;
        }
        self.cursor += 1;
    }
}

struct RuntimeMetrics {
    requested_buffer_size: u32,
    sample_rate: u32,
    input_sample_rate: u32,
    output_sample_rate: u32,
    input_buffer_size: AtomicU32,
    output_buffer_size: AtomicU32,
    ring_buffer_capacity_frames: u32,
    ring_buffer_fill_frames: AtomicU32,
    input_latency_us: AtomicU64,
    output_latency_us: AtomicU64,
    engine_latency_us: AtomicU64,
    xruns: AtomicU32,
    callback_generation: AtomicU64,
    published_graph_generation: AtomicU64,
    published_graph_build_generation: AtomicU64,
    faulted: AtomicBool,
    buffer_fallback: AtomicBool,
    clock_sync: &'static str,
}

impl RuntimeMetrics {
    fn snapshot(&self) -> NativeAudioRuntimeSnapshot {
        let input_latency_us = optional_latency(self.input_latency_us.load(Ordering::Relaxed));
        let output_latency_us = optional_latency(self.output_latency_us.load(Ordering::Relaxed));
        let ring_fill = self.ring_buffer_fill_frames.load(Ordering::Relaxed);
        let ring_latency_ms = frames_to_ms(ring_fill, self.input_sample_rate);
        let engine_latency_ms = self.engine_latency_us.load(Ordering::Relaxed) as f64 / 1_000.0;
        let estimated_round_trip_latency_ms =
            input_latency_us
                .zip(output_latency_us)
                .map(|(input_us, output_us)| {
                    input_us as f64 / 1_000.0
                        + output_us as f64 / 1_000.0
                        + ring_latency_ms
                        + engine_latency_ms
                });

        NativeAudioRuntimeSnapshot {
            state: if self.faulted.load(Ordering::Relaxed) {
                "error".to_owned()
            } else {
                "running".to_owned()
            },
            requested_buffer_size: Some(self.requested_buffer_size),
            sample_rate: Some(self.sample_rate),
            input_sample_rate: Some(self.input_sample_rate),
            output_sample_rate: Some(self.output_sample_rate),
            input_buffer_size: Some(self.input_buffer_size.load(Ordering::Relaxed)),
            output_buffer_size: Some(self.output_buffer_size.load(Ordering::Relaxed)),
            ring_buffer_capacity_frames: Some(self.ring_buffer_capacity_frames),
            ring_buffer_fill_frames: Some(ring_fill),
            input_latency_ms: input_latency_us.map(|value| value as f64 / 1_000.0),
            output_latency_ms: output_latency_us.map(|value| value as f64 / 1_000.0),
            ring_buffer_latency_ms: Some(ring_latency_ms),
            engine_latency_ms: Some(engine_latency_ms),
            estimated_round_trip_latency_ms,
            xruns: self.xruns.load(Ordering::Relaxed),
            clock_sync: self.clock_sync.to_owned(),
            buffer_fallback: self.buffer_fallback.load(Ordering::Relaxed),
        }
    }
}
