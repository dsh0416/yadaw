use super::*;

pub(super) struct TransportShared {
    pub(super) state: Arc<AtomicU32>,
    pub(super) position_frames: Arc<AtomicU64>,
    pub(super) position_ticks: Arc<AtomicU64>,
    pub(super) sample_rate: AtomicU32,
    pub(super) effective_bpm_bits: AtomicU64,
    pub(super) clock_source: AtomicU32,
    pub(super) waiting_for: AtomicU32,
    pub(super) loop_enabled: AtomicBool,
    pub(super) loop_has_range: AtomicBool,
    pub(super) loop_start_tick: AtomicU64,
    pub(super) loop_end_tick: AtomicU64,
}

/// Read-only transport atomics shared with the MIDI recording actor.
#[derive(Clone)]
pub struct TransportClockHandle {
    pub state: Arc<AtomicU32>,
    pub position_frames: Arc<AtomicU64>,
    pub position_ticks: Arc<AtomicU64>,
    pub recording_state: u32,
}

impl TransportShared {
    pub(super) fn snapshot(&self) -> NativeTransportSnapshot {
        NativeTransportSnapshot {
            state: match self.state.load(Ordering::Relaxed) {
                TRANSPORT_PLAYING => "playing",
                TRANSPORT_RECORDING => "recording",
                TRANSPORT_COUNTING_IN => "counting-in",
                TRANSPORT_WAITING => "waiting",
                _ => "stopped",
            }
            .to_owned(),
            position_frames: self
                .position_frames
                .load(Ordering::Relaxed)
                .min(i64::MAX as u64) as i64,
            position_ticks: self
                .position_ticks
                .load(Ordering::Relaxed)
                .min(i64::MAX as u64) as i64,
            sample_rate: self.sample_rate.load(Ordering::Relaxed),
            effective_bpm: {
                let value = f64::from_bits(self.effective_bpm_bits.load(Ordering::Relaxed));
                value.is_finite().then_some(value)
            },
            clock_source: if self.clock_source.load(Ordering::Relaxed) == 1 {
                "external"
            } else {
                "internal"
            }
            .to_owned(),
            waiting_for: match self.waiting_for.load(Ordering::Relaxed) {
                1 => Some("play".to_owned()),
                2 => Some("record".to_owned()),
                _ => None,
            },
            loop_enabled: self.loop_enabled.load(Ordering::Acquire),
            loop_start_tick: self.loop_has_range.load(Ordering::Acquire).then(|| {
                self.loop_start_tick
                    .load(Ordering::Relaxed)
                    .min(i64::MAX as u64) as i64
            }),
            loop_end_tick: self.loop_has_range.load(Ordering::Acquire).then(|| {
                self.loop_end_tick
                    .load(Ordering::Relaxed)
                    .min(i64::MAX as u64) as i64
            }),
        }
    }
}

pub(super) struct MeterAtomics {
    pub(super) id: String,
    pub(super) pre_left: AtomicU32,
    pub(super) pre_right: AtomicU32,
    pub(super) post_left: AtomicU32,
    pub(super) post_right: AtomicU32,
    pub(super) held_left: AtomicU32,
    pub(super) held_right: AtomicU32,
    pub(super) clipped: AtomicBool,
}

impl MeterAtomics {
    pub(super) fn new(id: String) -> Self {
        Self {
            id,
            pre_left: AtomicU32::new(0.0_f32.to_bits()),
            pre_right: AtomicU32::new(0.0_f32.to_bits()),
            post_left: AtomicU32::new(0.0_f32.to_bits()),
            post_right: AtomicU32::new(0.0_f32.to_bits()),
            held_left: AtomicU32::new(0.0_f32.to_bits()),
            held_right: AtomicU32::new(0.0_f32.to_bits()),
            clipped: AtomicBool::new(false),
        }
    }

    pub(super) fn store(&self, peak: ChannelPeak, held: StereoFrame) {
        self.pre_left
            .store(peak.pre[0].to_bits(), Ordering::Relaxed);
        self.pre_right
            .store(peak.pre[1].to_bits(), Ordering::Relaxed);
        self.post_left
            .store(peak.post[0].to_bits(), Ordering::Relaxed);
        self.post_right
            .store(peak.post[1].to_bits(), Ordering::Relaxed);
        self.held_left.store(held[0].to_bits(), Ordering::Relaxed);
        self.held_right.store(held[1].to_bits(), Ordering::Relaxed);
        if held[0] >= 1.0 || held[1] >= 1.0 {
            self.clipped.store(true, Ordering::Relaxed);
        }
    }

    pub(super) fn snapshot(&self) -> NativeMixerChannelMeter {
        NativeMixerChannelMeter {
            channel_id: self.id.clone(),
            pre_left: f64::from(f32::from_bits(self.pre_left.load(Ordering::Relaxed))),
            pre_right: f64::from(f32::from_bits(self.pre_right.load(Ordering::Relaxed))),
            post_left: f64::from(f32::from_bits(self.post_left.load(Ordering::Relaxed))),
            post_right: f64::from(f32::from_bits(self.post_right.load(Ordering::Relaxed))),
            held_left: f64::from(f32::from_bits(self.held_left.load(Ordering::Relaxed))),
            held_right: f64::from(f32::from_bits(self.held_right.load(Ordering::Relaxed))),
            clipped: self.clipped.load(Ordering::Relaxed),
        }
    }

    pub(super) fn clear_clip(&self) {
        self.clipped.store(false, Ordering::Relaxed);
        self.held_left.store(0.0_f32.to_bits(), Ordering::Relaxed);
        self.held_right.store(0.0_f32.to_bits(), Ordering::Relaxed);
    }
}

pub(super) struct MeterBank {
    pub(super) channels: Vec<MeterAtomics>,
}

pub(super) struct InputPeakBank {
    pub(super) peaks: [AtomicU32; MAX_INPUT_CHANNELS],
}

impl InputPeakBank {
    pub(super) fn new() -> Self {
        Self {
            peaks: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }

    pub(super) fn observe(&self, channels: &[f32]) {
        for (peak, sample) in self.peaks.iter().zip(channels) {
            peak.fetch_max(sample.abs().to_bits(), Ordering::Relaxed);
        }
    }

    pub(super) fn take_all(&self, target: &mut [f32; MAX_INPUT_CHANNELS]) {
        for (target, peak) in target.iter_mut().zip(&self.peaks) {
            *target = f32::from_bits(peak.swap(0, Ordering::Relaxed));
        }
    }
}

pub(super) struct AtomicSampleWindow {
    pub(super) samples: Box<[AtomicU32]>,
    pub(super) start_frame: AtomicU64,
    pub(super) frame_count: AtomicUsize,
    pub(super) generation: AtomicU64,
}

impl AtomicSampleWindow {
    pub(super) fn new(capacity_frames: usize) -> Self {
        Self {
            samples: (0..capacity_frames.saturating_mul(2))
                .map(|_| AtomicU32::new(0))
                .collect(),
            start_frame: AtomicU64::new(0),
            frame_count: AtomicUsize::new(0),
            generation: AtomicU64::new(0),
        }
    }

    pub(super) fn store(&self, frame: usize, sample: StereoFrame) {
        self.samples[frame * 2].store(sample[0].to_bits(), Ordering::Relaxed);
        self.samples[frame * 2 + 1].store(sample[1].to_bits(), Ordering::Relaxed);
    }

    pub(super) fn load(&self, frame: usize) -> StereoFrame {
        [
            f32::from_bits(self.samples[frame * 2].load(Ordering::Relaxed)),
            f32::from_bits(self.samples[frame * 2 + 1].load(Ordering::Relaxed)),
        ]
    }
}

pub(super) struct StreamControl {
    pub(super) windows: [AtomicSampleWindow; 2],
    pub(super) active_window: AtomicUsize,
    pub(super) reader_window: AtomicUsize,
    pub(super) requested_frame: AtomicU64,
    pub(super) generation: AtomicU64,
    pub(super) shutdown: AtomicBool,
}

impl StreamControl {
    pub(super) fn new(capacity_frames: usize, initial_frame: usize) -> Self {
        Self {
            windows: [
                AtomicSampleWindow::new(capacity_frames),
                AtomicSampleWindow::new(capacity_frames),
            ],
            active_window: AtomicUsize::new(0),
            reader_window: AtomicUsize::new(0),
            requested_frame: AtomicU64::new(initial_frame as u64),
            generation: AtomicU64::new(1),
            shutdown: AtomicBool::new(false),
        }
    }
}
