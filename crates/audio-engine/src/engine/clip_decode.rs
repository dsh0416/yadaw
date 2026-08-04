use super::{
    Arc, ChannelKind, Duration, Ordering, Result, STREAM_WINDOW_SECONDS, StereoFrame,
    StreamControl, StreamTask, StreamWorkerPool, StreamingClip, WaveReader, audio_error,
    invalid_config, mpsc, thread,
};

pub fn decode_clip_audio(path: &str, target_sample_rate: u32) -> Result<Vec<StereoFrame>> {
    let mut reader =
        WaveReader::open(path).map_err(|error| audio_error("failed to open mixer clip", error))?;
    let format = reader
        .format()
        .map_err(|error| audio_error("failed to read mixer clip format", error))?;
    let frames = reader
        .frame_length()
        .map_err(|error| audio_error("failed to read mixer clip length", error))?
        as usize;
    let channels = usize::from(format.channel_count);
    if channels == 0 {
        return Err(invalid_config("mixer clip has no audio channels"));
    }
    let mut samples = vec![0.0_f32; frames.saturating_mul(channels)];
    let mut frame_reader = reader
        .audio_frame_reader()
        .map_err(|error| audio_error("failed to open mixer clip audio", error))?;
    let read_frames = frame_reader
        .read_frames(&mut samples)
        .map_err(|error| audio_error("failed to decode mixer clip", error))?
        as usize;
    samples.truncate(read_frames.saturating_mul(channels));
    let decoded: Vec<StereoFrame> = samples
        .chunks_exact(channels)
        .map(|frame| {
            let left = frame[0];
            let right = if channels > 1 { frame[1] } else { left };
            [left, right]
        })
        .collect();
    if decoded.is_empty() {
        return Ok(decoded);
    }
    if format.sample_rate == target_sample_rate {
        return Ok(decoded);
    }
    let target_frames = ((decoded.len() as u128 * u128::from(target_sample_rate)
        + u128::from(format.sample_rate) / 2)
        / u128::from(format.sample_rate)) as usize;
    let ratio = f64::from(format.sample_rate) / f64::from(target_sample_rate);
    Ok((0..target_frames)
        .map(|frame| {
            let position = frame as f64 * ratio;
            let base = position.floor() as usize;
            let next = (base + 1).min(decoded.len().saturating_sub(1));
            let fraction = (position - base as f64) as f32;
            let first = decoded[base.min(decoded.len().saturating_sub(1))];
            let second = decoded[next];
            [
                first[0] + (second[0] - first[0]) * fraction,
                first[1] + (second[1] - first[1]) * fraction,
            ]
        })
        .collect())
}

pub(super) fn spawn_streaming_clip(
    path: String,
    target_sample_rate: u32,
    initial_frame: usize,
) -> Result<(StreamingClip, usize)> {
    let mut metadata_reader = WaveReader::open(&path)
        .map_err(|error| audio_error("failed to inspect streaming mixer clip", error))?;
    let format = metadata_reader
        .format()
        .map_err(|error| audio_error("failed to read streaming clip format", error))?;
    let source_frames = metadata_reader
        .frame_length()
        .map_err(|error| audio_error("failed to read streaming clip length", error))?
        as usize;
    let source_channels = usize::from(format.channel_count);
    if source_channels == 0 || format.sample_rate == 0 {
        return Err(invalid_config("streaming mixer clip has an invalid format"));
    }
    let target_frames = ((source_frames as u128 * u128::from(target_sample_rate)
        + u128::from(format.sample_rate) / 2)
        / u128::from(format.sample_rate)) as usize;
    let capacity = (target_sample_rate as usize)
        .saturating_mul(STREAM_WINDOW_SECONDS)
        .max(1);
    let control = Arc::new(StreamControl::new(capacity, initial_frame));
    let worker_control = Arc::clone(&control);
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let reader =
        WaveReader::open(&path).map_err(|error| audio_error("clip prefetch failed", error))?;
    let mut frame_reader = reader
        .audio_frame_reader()
        .map_err(|error| audio_error("clip prefetch failed", error))?;
    let source_ratio = f64::from(format.sample_rate) / f64::from(target_sample_rate);
    let prefetch_threshold = (target_sample_rate as usize / 2).max(1);
    let overlap = (target_sample_rate as usize / 4).max(1);
    let mut source_buffer = Vec::<f32>::new();
    let mut ready_sender = Some(ready_sender);
    StreamWorkerPool::global()
        .submit(StreamTask {
            tick: Box::new(move || {
                if worker_control.shutdown.load(Ordering::Acquire) {
                    return false;
                }
                let result = (|| -> std::result::Result<(), String> {
                    let generation = worker_control.generation.load(Ordering::Acquire);
                    let requested = worker_control.requested_frame.load(Ordering::Acquire) as usize;
                    let active = worker_control.active_window.load(Ordering::Acquire);
                    let active_window = &worker_control.windows[active];
                    let active_generation = active_window.generation.load(Ordering::Acquire);
                    let active_start = active_window.start_frame.load(Ordering::Relaxed) as usize;
                    let active_count = active_window.frame_count.load(Ordering::Relaxed);
                    let active_end = active_start.saturating_add(active_count);
                    let covered = active_generation == generation
                        && requested >= active_start
                        && requested < active_end;
                    if covered && active_end.saturating_sub(requested) > prefetch_threshold {
                        return Ok(());
                    }

                    let window_start = if covered {
                        active_end.saturating_sub(overlap)
                    } else {
                        requested
                    };
                    let window_count = capacity.min(target_frames.saturating_sub(window_start));
                    let inactive = 1 - active;
                    while worker_control.reader_window.load(Ordering::Acquire) == inactive + 1
                        && !worker_control.shutdown.load(Ordering::Acquire)
                    {
                        thread::yield_now();
                    }
                    if worker_control.shutdown.load(Ordering::Acquire) {
                        return Ok(());
                    }

                    let source_start = (window_start as f64 * source_ratio).floor() as usize;
                    let source_end = (((window_start.saturating_add(window_count)) as f64
                        * source_ratio)
                        .ceil() as usize)
                        .saturating_add(1)
                        .min(source_frames);
                    let requested_source_frames = source_end.saturating_sub(source_start);
                    source_buffer
                        .resize(requested_source_frames.saturating_mul(source_channels), 0.0);
                    frame_reader
                        .locate(source_start as u64)
                        .map_err(|error| error.to_string())?;
                    let read_frames = frame_reader
                        .read_frames(&mut source_buffer)
                        .map_err(|error| error.to_string())?
                        as usize;
                    source_buffer.truncate(read_frames.saturating_mul(source_channels));

                    let window = &worker_control.windows[inactive];
                    let mut written = 0;
                    for output_index in 0..window_count {
                        if generation != worker_control.generation.load(Ordering::Acquire) {
                            break;
                        }
                        let source_position = (window_start + output_index) as f64 * source_ratio;
                        let base_source = source_position.floor() as usize;
                        let local = base_source.saturating_sub(source_start);
                        if local >= read_frames {
                            break;
                        }
                        let next = (local + 1).min(read_frames.saturating_sub(1));
                        let fraction = (source_position - base_source as f64) as f32;
                        let first_left = source_buffer[local * source_channels];
                        let second_left = source_buffer[next * source_channels];
                        let first_right = if source_channels > 1 {
                            source_buffer[local * source_channels + 1]
                        } else {
                            first_left
                        };
                        let second_right = if source_channels > 1 {
                            source_buffer[next * source_channels + 1]
                        } else {
                            second_left
                        };
                        window.store(
                            output_index,
                            [
                                first_left + (second_left - first_left) * fraction,
                                first_right + (second_right - first_right) * fraction,
                            ],
                        );
                        written += 1;
                    }
                    if generation != worker_control.generation.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    window
                        .start_frame
                        .store(window_start as u64, Ordering::Relaxed);
                    window.frame_count.store(written, Ordering::Relaxed);
                    window.generation.store(generation, Ordering::Release);
                    worker_control
                        .active_window
                        .store(inactive, Ordering::Release);
                    if let Some(sender) = ready_sender.take() {
                        let _ = sender.send(Ok(()));
                    }
                    Ok(())
                })();
                if let Err(message) = result {
                    worker_control.shutdown.store(true, Ordering::Release);
                    if let Some(sender) = ready_sender.take() {
                        let _ = sender.send(Err(message));
                    }
                    return false;
                }
                true
            }),
        })
        .map_err(|error| audio_error("failed to submit clip prefetch task", error))?;
    match ready_receiver.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok((
            StreamingClip {
                control,
                expected_frame: Some(initial_frame),
            },
            target_frames,
        )),
        Ok(Err(message)) => {
            control.shutdown.store(true, Ordering::Release);
            Err(audio_error("clip prefetch failed", message))
        }
        Err(error) => {
            control.shutdown.store(true, Ordering::Release);
            Err(audio_error("clip prefetch did not become ready", error))
        }
    }
}

pub(super) fn parse_channel_kind(value: &str) -> Result<ChannelKind> {
    match value {
        "audio" => Ok(ChannelKind::Audio),
        "instrument" => Ok(ChannelKind::Instrument),
        "aux" => Ok(ChannelKind::Aux),
        "master" => Ok(ChannelKind::Master),
        "output" => Ok(ChannelKind::Output),
        _ => Err(invalid_config("unknown mixer channel kind")),
    }
}
