#[cfg(any(test, feature = "bench-internals"))]
enum WriterCommand {
    Start {
        config: NativeRecordingStartConfig,
        reply: SyncSender<std::result::Result<(), String>>,
    },
    Stop {
        reply: SyncSender<std::result::Result<NativeRecordingResult, String>>,
    },
    Shutdown,
}

#[cfg(any(test, feature = "bench-internals"))]
struct ActiveWriter {
    path: String,
    frames: u64,
    writer: AudioFrameWriter<BufWriter<File>>,
}

#[cfg(any(test, feature = "bench-internals"))]
fn write_available(
    consumer: &mut HeapCons<InputFrame>,
    active: &mut ActiveWriter,
    scratch: &mut Vec<f32>,
    waveform: &Arc<Mutex<LiveWaveform>>,
    channel_count: usize,
) -> std::result::Result<(), String> {
    scratch.clear();
    while scratch.len() < WRITER_BLOCK_FRAMES * channel_count {
        let Some(frame) = consumer.try_pop() else {
            break;
        };
        scratch.extend_from_slice(&frame[..channel_count]);
    }
    if scratch.is_empty() {
        return Ok(());
    }
    active
        .writer
        .write_frames(scratch)
        .map_err(|error| error.to_string())?;
    waveform
        .lock()
        .map_err(|_| "waveform state is poisoned".to_owned())?
        .push(scratch);
    active.frames += (scratch.len() / channel_count) as u64;
    Ok(())
}

#[cfg(any(test, feature = "bench-internals"))]
fn writer_thread(
    mut consumer: HeapCons<InputFrame>,
    receiver: Receiver<WriterCommand>,
    active_flag: Arc<AtomicBool>,
    dropout_frames: Arc<AtomicU64>,
    sample_rate: u32,
    channel_count: usize,
    waveform: Arc<Mutex<LiveWaveform>>,
) {
    let mut current: Option<ActiveWriter> = None;
    let mut scratch = Vec::with_capacity(WRITER_BLOCK_FRAMES * channel_count);
    loop {
        if let Some(active) = current.as_mut()
            && write_available(
                &mut consumer,
                active,
                &mut scratch,
                &waveform,
                channel_count,
            )
            .is_err()
        {
            active_flag.store(false, Ordering::Release);
        }

        match receiver.recv_timeout(Duration::from_millis(5)) {
            Ok(WriterCommand::Start { config, reply }) => {
                let result = (|| {
                    if current.is_some() {
                        return Err("a recording is already active".to_owned());
                    }
                    while consumer.try_pop().is_some() {}
                    dropout_frames.store(0, Ordering::Relaxed);
                    waveform
                        .lock()
                        .map_err(|_| "waveform state is poisoned".to_owned())?
                        .reset(sample_rate, channel_count);
                    let mut writer =
                        WaveWriter::create(&config.path, float_format(sample_rate, channel_count))
                            .map_err(|error| error.to_string())?;
                    writer
                        .write_broadcast_metadata(&broadcast_metadata(
                            &config.asset_id,
                            &config.originator,
                            &config.origination_date,
                            &config.origination_time,
                            config.time_reference.max(0) as u64,
                            format!(
                                "A=PCM,F={sample_rate},W=32,M={channel_count} channel,T=YADAW swap\r\n"
                            ),
                        ))
                        .map_err(|error| error.to_string())?;
                    current = Some(ActiveWriter {
                        path: config.path,
                        frames: 0,
                        writer: writer
                            .audio_frame_writer()
                            .map_err(|error| error.to_string())?,
                    });
                    active_flag.store(true, Ordering::Release);
                    Ok(())
                })();
                let _ = reply.send(result);
            }
            Ok(WriterCommand::Stop { reply }) => {
                active_flag.store(false, Ordering::Release);
                let result = (|| {
                    let mut writer = current
                        .take()
                        .ok_or_else(|| "no recording is active".to_owned())?;
                    while consumer.occupied_len() > 0 {
                        write_available(
                            &mut consumer,
                            &mut writer,
                            &mut scratch,
                            &waveform,
                            channel_count,
                        )?;
                    }
                    let path = writer.path.clone();
                    let frames = writer.frames;
                    writer.writer.end().map_err(|error| error.to_string())?;
                    OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&path)
                        .and_then(|file| file.sync_all())
                        .map_err(|error| error.to_string())?;
                    Ok(NativeRecordingResult {
                        path,
                        sample_rate,
                        channels: channel_count as u32,
                        frame_count: frames.min(i64::MAX as u64) as i64,
                        dropout_frames: dropout_frames.load(Ordering::Relaxed).min(i64::MAX as u64)
                            as i64,
                    })
                })();
                let _ = reply.send(result);
            }
            Ok(WriterCommand::Shutdown) => {
                active_flag.store(false, Ordering::Release);
                if let Some(mut writer) = current.take() {
                    while consumer.occupied_len() > 0 {
                        let _ = write_available(
                            &mut consumer,
                            &mut writer,
                            &mut scratch,
                            &waveform,
                            channel_count,
                        );
                    }
                    let _ = writer.writer.end();
                }
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[cfg(any(test, feature = "bench-internals"))]
pub struct RecorderController {
    sender: Sender<WriterCommand>,
    active: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    #[allow(dead_code)]
    waveform: Arc<Mutex<LiveWaveform>>,
}

#[cfg(any(test, feature = "bench-internals"))]
impl RecorderController {
    pub fn new(sample_rate: u32, channel_count: usize) -> (Self, RecordingTap) {
        let channel_count = channel_count.clamp(1, MAX_INPUT_CHANNELS);
        let capacity = sample_rate as usize * RECORDING_RING_SECONDS;
        let ring = HeapRb::<InputFrame>::new(capacity.max(8_192));
        let (producer, consumer) = ring.split();
        let active = Arc::new(AtomicBool::new(false));
        let dropout_frames = Arc::new(AtomicU64::new(0));
        let (sender, receiver) = mpsc::channel();
        let waveform = Arc::new(Mutex::new(LiveWaveform::default()));
        let thread_waveform = Arc::clone(&waveform);
        let thread_active = Arc::clone(&active);
        let thread_dropouts = Arc::clone(&dropout_frames);
        let thread = thread::Builder::new()
            .name("yadaw-recording-writer".to_owned())
            .spawn(move || {
                writer_thread(
                    consumer,
                    receiver,
                    thread_active,
                    thread_dropouts,
                    sample_rate,
                    channel_count,
                    thread_waveform,
                );
            })
            .expect("recording writer thread must start");
        (
            Self {
                sender,
                active: Arc::clone(&active),
                thread: Some(thread),
                waveform,
            },
            RecordingTap {
                producer,
                active,
                dropout_frames,
                channel_count,
            },
        )
    }

    pub fn start(&self, config: NativeRecordingStartConfig) -> Result<()> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(WriterCommand::Start { config, reply })
            .map_err(|error| recording_error("recording writer stopped", error))?;
        response
            .recv()
            .map_err(|error| recording_error("recording writer stopped", error))?
            .map_err(|error| recording_error("failed to start recording", error))
    }

    pub fn stop(&self) -> Result<NativeRecordingResult> {
        self.active.store(false, Ordering::Release);
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(WriterCommand::Stop { reply })
            .map_err(|error| recording_error("recording writer stopped", error))?;
        response
            .recv()
            .map_err(|error| recording_error("recording writer stopped", error))?
            .map_err(|error| recording_error("failed to stop recording", error))
    }

    #[allow(dead_code)]
    pub fn waveform_snapshot(
        &self,
        start_frame: i64,
        end_frame: i64,
        max_buckets: u32,
    ) -> Result<NativeWaveformSnapshot> {
        if start_frame < 0 || end_frame < start_frame || max_buckets == 0 {
            return Err(Error::new(Status::InvalidArg, "invalid waveform window"));
        }
        let waveform = self
            .waveform
            .lock()
            .map_err(|_| recording_error("waveform state", "poisoned"))?;
        Ok(waveform.snapshot(
            start_frame as usize,
            end_frame as usize,
            max_buckets as usize,
        ))
    }
}

#[cfg(any(test, feature = "bench-internals"))]
impl Drop for RecorderController {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        let _ = self.sender.send(WriterCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
