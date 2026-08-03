/// Cooperative shutdown and transport flags shared with a stream worker.
struct StreamControls {
    exit: AtomicBool,
    playing: AtomicBool,
}

/// A mock cpal stream driven by a wall-clock worker thread.
///
/// The worker never reports stream errors: a mock device cannot be unplugged,
/// cannot be claimed by another process, and absorbs its own scheduling jitter,
/// so the error callback supplied by the engine is intentionally unused.
///
/// [`StreamTrait::play`] and [`StreamTrait::pause`] signal the worker rather
/// than synchronising with it, so a block already in flight when `pause` is
/// called still reaches the data callback. Only dropping the stream waits for
/// the worker to finish.
struct MockStream {
    controls: Arc<StreamControls>,
    origin: Instant,
    frames: FrameCount,
    worker: Option<JoinHandle<()>>,
}

cpal::assert_stream_send!(MockStream);
cpal::assert_stream_sync!(MockStream);

/// Paces a stream worker at one block per buffer period.
struct BlockClock {
    period: Duration,
    next: Instant,
}

impl BlockClock {
    fn new(period: Duration) -> Self {
        Self {
            period,
            next: Instant::now() + period,
        }
    }

    /// Restarts the schedule, used when a paused worker resumes.
    fn restart(&mut self) {
        self.next = Instant::now() + self.period;
    }

    /// How long until the next block is due, or zero when it is already due.
    fn remaining(&self) -> Duration {
        self.next.saturating_duration_since(Instant::now())
    }

    /// Moves on to the next block.
    ///
    /// Small overruns are absorbed by the accumulated schedule so the average
    /// rate stays accurate. After a long stall the schedule is resynchronised
    /// instead, because a descheduled worker catching up with a burst of
    /// callbacks would look nothing like a real device.
    fn advance(&mut self) {
        self.next += self.period;
        let now = Instant::now();
        if self.next + self.period < now {
            self.next = now + self.period;
        }
    }
}

fn block_duration(frames: FrameCount) -> Duration {
    Duration::from_nanos(u64::from(frames) * 1_000_000_000 / u64::from(SAMPLE_RATE))
}

/// How often a worker wakes while waiting, so pausing and dropping a stream stay
/// responsive even with the largest supported buffer.
fn poll_interval(period: Duration) -> Duration {
    (period / 8).max(Duration::from_micros(50))
}

fn stream_instant(elapsed: Duration) -> StreamInstant {
    StreamInstant::new(elapsed.as_secs(), elapsed.subsec_nanos())
}

impl MockStream {
    fn spawn<W>(name: &str, frames: FrameCount, origin: Instant, worker: W) -> Result<Self, Error>
    where
        W: FnOnce(Arc<StreamControls>) + Send + 'static,
    {
        let controls = Arc::new(StreamControls {
            exit: AtomicBool::new(false),
            playing: AtomicBool::new(false),
        });
        let worker_controls = Arc::clone(&controls);
        let handle = thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || worker(worker_controls))
            .map_err(|error| {
                Error::with_message(
                    ErrorKind::ResourceExhausted,
                    format!("failed to start the mock audio worker: {error}"),
                )
            })?;
        Ok(Self {
            controls,
            origin,
            frames,
            worker: Some(handle),
        })
    }

    fn capture<D>(
        backend: &Arc<MockBackend>,
        frames: FrameCount,
        channels: usize,
        mut data_callback: D,
    ) -> Result<Self, Error>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
    {
        let mut loopback = backend.claim_loopback_consumer();
        let origin = backend.origin;
        let period = block_duration(frames);
        let block_frames = frames as usize;
        let backlog_limit = block_frames * LOOPBACK_SLACK_BLOCKS;
        Self::spawn("heron-mock-capture", frames, origin, move |controls| {
            let mut buffer = vec![0.0_f32; block_frames * channels];
            let mut clock = BlockClock::new(period);
            let poll = poll_interval(period);
            while !controls.exit.load(Ordering::Acquire) {
                if !controls.playing.load(Ordering::Acquire) {
                    thread::sleep(poll);
                    clock.restart();
                    continue;
                }
                if let Some(loopback) = loopback.as_mut() {
                    // Bound how far capture may trail playback so loopback
                    // latency stays close to a single block.
                    while loopback.occupied_len() > backlog_limit {
                        let _ = loopback.try_pop();
                    }
                }
                // Capture is slaved to playback so the loopback signal arrives
                // in contiguous blocks. The block clock is the fallback for a
                // capture-only stream, which has no playback to follow.
                let looped_back = loopback
                    .as_ref()
                    .is_some_and(|loopback| loopback.occupied_len() >= block_frames);
                if !looped_back {
                    let remaining = clock.remaining();
                    if !remaining.is_zero() {
                        thread::sleep(poll.min(remaining));
                        continue;
                    }
                }

                buffer.fill(0.0);
                if let Some(loopback) = loopback.as_mut() {
                    for frame in buffer.chunks_exact_mut(channels) {
                        let Some(captured) = loopback.try_pop() else {
                            break;
                        };
                        for (sample, captured) in frame.iter_mut().zip(captured) {
                            *sample = captured;
                        }
                    }
                }
                let callback = stream_instant(origin.elapsed());
                let capture = callback.checked_sub(period).unwrap_or(StreamInstant::ZERO);
                // SAFETY: `buffer` is a live, correctly aligned `f32` allocation
                // of `buffer.len()` samples for the duration of the call, and
                // `SAMPLE_FORMAT` is the format this stream negotiated.
                let data = unsafe {
                    Data::from_parts(buffer.as_mut_ptr().cast(), buffer.len(), SAMPLE_FORMAT)
                };
                data_callback(
                    &data,
                    &InputCallbackInfo::new(InputStreamTimestamp { callback, capture }),
                );
                clock.advance();
            }
        })
    }

    fn playback<D>(
        backend: &Arc<MockBackend>,
        frames: FrameCount,
        channels: usize,
        mut data_callback: D,
    ) -> Result<Self, Error>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
    {
        let mut loopback = backend.claim_loopback_producer();
        let origin = backend.origin;
        let period = block_duration(frames);
        let block_frames = frames as usize;
        if let Some(loopback) = loopback.as_mut() {
            // Give capture a block of silence to read immediately so playback
            // stays one block ahead once both streams are running.
            for _ in 0..block_frames {
                let _ = loopback.try_push([0.0; CHANNELS as usize]);
            }
        }
        Self::spawn("heron-mock-playback", frames, origin, move |controls| {
            let mut buffer = vec![0.0_f32; block_frames * channels];
            let mut clock = BlockClock::new(period);
            let poll = poll_interval(period);
            while !controls.exit.load(Ordering::Acquire) {
                if !controls.playing.load(Ordering::Acquire) {
                    thread::sleep(poll);
                    clock.restart();
                    continue;
                }
                let remaining = clock.remaining();
                if !remaining.is_zero() {
                    thread::sleep(poll.min(remaining));
                    continue;
                }

                buffer.fill(0.0);
                let callback = stream_instant(origin.elapsed());
                let playback = callback.checked_add(period).unwrap_or(callback);
                // SAFETY: `buffer` is a live, correctly aligned `f32` allocation
                // of `buffer.len()` samples for the duration of the call, and
                // `SAMPLE_FORMAT` is the format this stream negotiated.
                let mut data = unsafe {
                    Data::from_parts(buffer.as_mut_ptr().cast(), buffer.len(), SAMPLE_FORMAT)
                };
                data_callback(
                    &mut data,
                    &OutputCallbackInfo::new(OutputStreamTimestamp { callback, playback }),
                );
                if let Some(loopback) = loopback.as_mut() {
                    for frame in buffer.chunks_exact(channels) {
                        let mut played = [0.0; CHANNELS as usize];
                        for (target, sample) in played.iter_mut().zip(frame) {
                            *target = *sample;
                        }
                        if loopback.try_push(played).is_err() {
                            break;
                        }
                    }
                }
                clock.advance();
            }
        })
    }
}

impl StreamTrait for MockStream {
    fn play(&self) -> Result<(), Error> {
        self.controls.playing.store(true, Ordering::Release);
        Ok(())
    }

    fn pause(&self) -> Result<(), Error> {
        self.controls.playing.store(false, Ordering::Release);
        Ok(())
    }

    fn now(&self) -> StreamInstant {
        stream_instant(self.origin.elapsed())
    }

    fn buffer_size(&self) -> Result<FrameCount, Error> {
        Ok(self.frames)
    }
}

impl Drop for MockStream {
    fn drop(&mut self) {
        self.controls.exit.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
