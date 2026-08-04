use super::{
    Arc, AtomicUsize, Duration, Ordering, STREAM_WORKERS, StereoFrame, StreamControl, mpsc, thread,
};

pub(super) struct StreamingClip {
    pub(super) control: Arc<StreamControl>,
    pub(super) expected_frame: Option<usize>,
}

impl StreamingClip {
    pub(super) fn sample_at(&mut self, frame: usize) -> Option<StereoFrame> {
        if self.expected_frame != Some(frame) {
            self.control.generation.fetch_add(1, Ordering::AcqRel);
        }
        self.expected_frame = frame.checked_add(1);
        self.control
            .requested_frame
            .store(frame as u64, Ordering::Release);

        for _ in 0..2 {
            let active = self.control.active_window.load(Ordering::Acquire);
            self.control
                .reader_window
                .store(active + 1, Ordering::Release);
            if active != self.control.active_window.load(Ordering::Acquire) {
                self.control.reader_window.store(0, Ordering::Release);
                continue;
            }
            let window = &self.control.windows[active];
            let generation = window.generation.load(Ordering::Acquire);
            let start = window.start_frame.load(Ordering::Relaxed) as usize;
            let count = window.frame_count.load(Ordering::Relaxed);
            let sample = (generation == self.control.generation.load(Ordering::Acquire)
                && frame >= start
                && frame < start.saturating_add(count))
            .then(|| window.load(frame - start));
            self.control.reader_window.store(0, Ordering::Release);
            return sample;
        }
        None
    }
}

impl Drop for StreamingClip {
    fn drop(&mut self) {
        self.control.shutdown.store(true, Ordering::Release);
    }
}

pub(super) struct StreamTask {
    pub(super) tick: Box<dyn FnMut() -> bool + Send>,
}

pub(super) struct StreamWorkerPool {
    pub(super) lanes: Vec<mpsc::SyncSender<StreamTask>>,
    pub(super) next_lane: AtomicUsize,
}

impl StreamWorkerPool {
    pub(super) fn global() -> &'static Self {
        STREAM_WORKERS.get_or_init(|| {
            let lane_count = thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(2)
                .clamp(2, 4);
            let mut lanes = Vec::with_capacity(lane_count);
            for lane in 0..lane_count {
                let (sender, receiver) = mpsc::sync_channel::<StreamTask>(128);
                thread::Builder::new()
                    .name(format!("heron-background-io-{lane}"))
                    .spawn(move || stream_worker_lane(receiver))
                    .expect("background I/O worker must start");
                lanes.push(sender);
            }
            Self {
                lanes,
                next_lane: AtomicUsize::new(0),
            }
        })
    }

    pub(super) fn submit(&self, task: StreamTask) -> std::result::Result<(), String> {
        let lane = self.next_lane.fetch_add(1, Ordering::Relaxed) % self.lanes.len();
        self.lanes[lane]
            .send(task)
            .map_err(|error| error.to_string())
    }
}

fn stream_worker_lane(receiver: mpsc::Receiver<StreamTask>) {
    let mut tasks = Vec::<StreamTask>::new();
    loop {
        if tasks.is_empty() {
            match receiver.recv() {
                Ok(task) => tasks.push(task),
                Err(_) => return,
            }
        }
        while let Ok(task) = receiver.try_recv() {
            tasks.push(task);
        }
        tasks.retain_mut(|task| (task.tick)());
        thread::sleep(Duration::from_millis(2));
    }
}

pub(super) enum ClipSamples {
    Memory(Vec<StereoFrame>),
    Streaming(StreamingClip),
}

pub(super) struct LoadedClip {
    pub(super) channel_index: usize,
    pub(super) start_frame: u64,
    pub(super) source_offset_frames: usize,
    pub(super) length_frames: usize,
    pub(super) fade_in_frames: usize,
    pub(super) fade_out_frames: usize,
    pub(super) samples: ClipSamples,
}

impl LoadedClip {
    pub(super) fn sample_at(&mut self, relative: usize) -> Option<StereoFrame> {
        let source_frame = self.source_offset_frames.checked_add(relative)?;
        match &mut self.samples {
            ClipSamples::Memory(samples) => samples.get(source_frame).copied(),
            ClipSamples::Streaming(stream) => stream.sample_at(source_frame),
        }
    }

    pub(super) fn gain_at(&self, relative: usize) -> f32 {
        let fade_in = if self.fade_in_frames == 0 || relative >= self.fade_in_frames {
            1.0
        } else {
            ((relative as f32) / (self.fade_in_frames as f32)).sqrt()
        };
        let remaining = self.length_frames.saturating_sub(relative);
        let fade_out = if self.fade_out_frames == 0 || remaining > self.fade_out_frames {
            1.0
        } else {
            ((remaining as f32) / (self.fade_out_frames as f32)).sqrt()
        };
        fade_in * fade_out
    }
}
