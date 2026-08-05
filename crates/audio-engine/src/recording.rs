use std::{
    fs::{File, OpenOptions},
    io::BufWriter,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use bwavfile::{AudioFrameWriter, Bext, WAVE_TAG_FLOAT, WaveFmt, WaveWriter};
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};

use crate::{HostError, HostResult, Status};

pub type StereoFrame = [f32; 2];
pub const MAX_INPUT_CHANNELS: usize = 32;
pub type InputFrame = [f32; MAX_INPUT_CHANNELS];

const RECORDING_RING_SECONDS: usize = 8;
const WRITER_BLOCK_FRAMES: usize = 2_048;
const WAVEFORM_BASE_FRAMES: usize = 64;
const WAVEFORM_LEVEL_FACTOR: usize = 4;

#[derive(Debug, Clone)]
pub struct NativeRecordingStartConfig {
    pub path: String,
    pub asset_id: String,
    pub originator: String,
    pub origination_date: String,
    pub origination_time: String,
    pub time_reference: i64,
    pub sample_rate: u32,
    pub channels: u32,
}

#[derive(Debug, Clone)]
pub struct NativeRecordingResult {
    pub path: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub dropout_frames: i64,
}

#[derive(Debug, Clone)]
pub struct NativeWaveformSnapshot {
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub start_frame: i64,
    pub end_frame: i64,
    pub frames_per_bucket: u32,
    pub bucket_count: u32,
    pub peaks: Vec<u8>,
}

fn error(context: &str, value: impl std::fmt::Display) -> HostError {
    HostError::new(Status::GenericFailure, format!("{context}: {value}"))
}

fn finite_sample(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn encode_peaks(values: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(values));
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn aggregate_peak_level(source: &[f32], channels: usize) -> Vec<f32> {
    let stride = channels * 2;
    let buckets = source.len() / stride;
    let mut result = Vec::with_capacity(buckets.div_ceil(WAVEFORM_LEVEL_FACTOR) * stride);
    for group_start in (0..buckets).step_by(WAVEFORM_LEVEL_FACTOR) {
        let group_end = (group_start + WAVEFORM_LEVEL_FACTOR).min(buckets);
        for channel in 0..channels {
            let mut minimum = 1.0_f32;
            let mut maximum = -1.0_f32;
            for bucket in group_start..group_end {
                let offset = bucket * stride + channel * 2;
                minimum = minimum.min(source[offset]);
                maximum = maximum.max(source[offset + 1]);
            }
            result.extend_from_slice(&[minimum, maximum]);
        }
    }
    result
}

#[derive(Default)]
struct LiveWaveform {
    sample_rate: u32,
    channels: usize,
    frame_count: usize,
    base_peaks: Vec<f32>,
    pending_peaks: Vec<f32>,
    pending_frames: usize,
}

impl LiveWaveform {
    fn reset_pending(&mut self) {
        self.pending_peaks.clear();
        for _ in 0..self.channels {
            self.pending_peaks.extend_from_slice(&[1.0, -1.0]);
        }
        self.pending_frames = 0;
    }

    fn reset(&mut self, sample_rate: u32, channels: usize) {
        self.sample_rate = sample_rate;
        self.channels = channels;
        self.frame_count = 0;
        self.base_peaks.clear();
        self.reset_pending();
    }

    fn push(&mut self, samples: &[f32]) {
        for frame in samples.chunks_exact(self.channels.max(1)) {
            for (channel, sample) in frame.iter().enumerate() {
                let value = finite_sample(*sample);
                let offset = channel * 2;
                self.pending_peaks[offset] = self.pending_peaks[offset].min(value);
                self.pending_peaks[offset + 1] = self.pending_peaks[offset + 1].max(value);
            }
            self.frame_count += 1;
            self.pending_frames += 1;
            if self.pending_frames == WAVEFORM_BASE_FRAMES {
                self.base_peaks.extend_from_slice(&self.pending_peaks);
                self.reset_pending();
            }
        }
    }

    fn snapshot(&self, start: usize, end: usize, max_buckets: usize) -> NativeWaveformSnapshot {
        let end = end.min(self.frame_count).max(start.min(self.frame_count));
        let start = start.min(end);
        let stride = self.channels * 2;
        let mut all_peaks = self.base_peaks.clone();
        if self.pending_frames > 0 {
            all_peaks.extend_from_slice(&self.pending_peaks);
        }
        let total_buckets = all_peaks.len() / stride.max(1);
        let first_bucket = (start / WAVEFORM_BASE_FRAMES).min(total_buckets);
        let last_bucket = end
            .div_ceil(WAVEFORM_BASE_FRAMES)
            .min(total_buckets)
            .max(first_bucket);
        let mut values = all_peaks[first_bucket * stride..last_bucket * stride].to_vec();
        let mut frames_per_bucket = WAVEFORM_BASE_FRAMES;
        while values.len() / stride.max(1) > max_buckets.max(1) {
            values = aggregate_peak_level(&values, self.channels);
            frames_per_bucket *= WAVEFORM_LEVEL_FACTOR;
        }
        NativeWaveformSnapshot {
            sample_rate: self.sample_rate,
            channels: self.channels as u32,
            frame_count: self.frame_count.min(i64::MAX as usize) as i64,
            start_frame: (first_bucket * WAVEFORM_BASE_FRAMES).min(i64::MAX as usize) as i64,
            end_frame: (last_bucket * WAVEFORM_BASE_FRAMES)
                .min(self.frame_count)
                .min(i64::MAX as usize) as i64,
            frames_per_bucket: frames_per_bucket as u32,
            bucket_count: (values.len() / stride.max(1)) as u32,
            peaks: encode_peaks(&values),
        }
    }
}

fn float_format(sample_rate: u32, channels: usize) -> WaveFmt {
    let channels = channels.clamp(1, u16::MAX as usize) as u16;
    let block_alignment = channels.saturating_mul(4);
    WaveFmt {
        tag: WAVE_TAG_FLOAT,
        channel_count: channels,
        sample_rate,
        bytes_per_second: sample_rate.saturating_mul(u32::from(block_alignment)),
        block_alignment,
        bits_per_sample: 32,
        extended_format: None,
    }
}

fn metadata(config: &NativeRecordingStartConfig, sample_rate: u32, channels: usize) -> Bext {
    Bext {
        description: format!("Heron recording {}", config.asset_id),
        originator: config.originator.clone(),
        originator_reference: config.asset_id.clone(),
        origination_date: config.origination_date.clone(),
        origination_time: config.origination_time.clone(),
        time_reference: config.time_reference.max(0) as u64,
        version: 1,
        umid: None,
        loudness_value: None,
        loudness_range: None,
        max_true_peak_level: None,
        max_momentary_loudness: None,
        max_short_term_loudness: None,
        coding_history: format!("A=PCM,F={sample_rate},W=32,M={channels} channel,T=Heron swap\r\n"),
    }
}

pub struct RecordingTap {
    producer: HeapProd<InputFrame>,
    active: Arc<AtomicBool>,
    dropout_frames: Arc<AtomicU64>,
    channel_count: Arc<AtomicU32>,
    transport_state: Arc<AtomicU32>,
    recording_state: u32,
}

impl RecordingTap {
    pub fn push(&mut self, channels: &[f32]) {
        if !self.active.load(Ordering::Relaxed)
            || self.transport_state.load(Ordering::Relaxed) != self.recording_state
        {
            return;
        }
        let mut frame = [0.0_f32; MAX_INPUT_CHANNELS];
        let count = channels
            .len()
            .min(self.channel_count.load(Ordering::Relaxed) as usize)
            .min(MAX_INPUT_CHANNELS);
        frame[..count].copy_from_slice(&channels[..count]);
        if self.producer.try_push(frame).is_err() {
            self.dropout_frames.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
pub(crate) fn recording_tap_for_test(
    transport_state: Arc<AtomicU32>,
    recording_state: u32,
    channels: u32,
) -> (RecordingTap, HeapCons<InputFrame>) {
    let (producer, consumer) = HeapRb::<InputFrame>::new(16).split();
    (
        RecordingTap {
            producer,
            active: Arc::new(AtomicBool::new(true)),
            dropout_frames: Arc::new(AtomicU64::new(0)),
            channel_count: Arc::new(AtomicU32::new(channels)),
            transport_state,
            recording_state,
        },
        consumer,
    )
}

enum WriterCommand {
    Start {
        config: NativeRecordingStartConfig,
        reply: SyncSender<Result<(), String>>,
    },
    Stop {
        reply: SyncSender<Result<NativeRecordingResult, String>>,
    },
    Shutdown,
}

struct ActiveWriter {
    path: String,
    frames: u64,
    sample_rate: u32,
    channel_count: usize,
    writer: AudioFrameWriter<BufWriter<File>>,
}

fn write_available(
    consumer: &mut HeapCons<InputFrame>,
    active: &mut ActiveWriter,
    scratch: &mut Vec<f32>,
    waveform: &Arc<Mutex<LiveWaveform>>,
) -> Result<(), String> {
    let channel_count = active.channel_count;
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
        .map_err(|value| value.to_string())?;
    waveform
        .lock()
        .map_err(|_| "waveform state is poisoned".to_owned())?
        .push(scratch);
    active.frames += (scratch.len() / channel_count) as u64;
    Ok(())
}

fn writer_thread(
    mut consumer: HeapCons<InputFrame>,
    receiver: Receiver<WriterCommand>,
    active_flag: Arc<AtomicBool>,
    dropout_frames: Arc<AtomicU64>,
    channel_count: Arc<AtomicU32>,
    waveform: Arc<Mutex<LiveWaveform>>,
) {
    let mut current: Option<ActiveWriter> = None;
    let mut scratch = Vec::with_capacity(WRITER_BLOCK_FRAMES * MAX_INPUT_CHANNELS);
    loop {
        if let Some(active) = current.as_mut() {
            let _ = write_available(&mut consumer, active, &mut scratch, &waveform);
        }
        match receiver.recv_timeout(Duration::from_millis(5)) {
            Ok(WriterCommand::Start { config, reply }) => {
                let result = (|| {
                    if current.is_some() {
                        return Err("a recording is already active".to_owned());
                    }
                    while consumer.try_pop().is_some() {}
                    let sample_rate = config.sample_rate;
                    let configured_channels = usize::try_from(config.channels)
                        .unwrap_or(0)
                        .clamp(1, MAX_INPUT_CHANNELS);
                    if config.sample_rate == 0
                        || config.channels == 0
                        || configured_channels as u32 != config.channels
                    {
                        return Err("recording format is invalid".to_owned());
                    }
                    dropout_frames.store(0, Ordering::Relaxed);
                    channel_count.store(config.channels, Ordering::Release);
                    waveform
                        .lock()
                        .map_err(|_| "waveform state is poisoned".to_owned())?
                        .reset(sample_rate, configured_channels);
                    let mut writer = WaveWriter::create(
                        &config.path,
                        float_format(sample_rate, configured_channels),
                    )
                    .map_err(|value| value.to_string())?;
                    writer
                        .write_broadcast_metadata(&metadata(
                            &config,
                            sample_rate,
                            configured_channels,
                        ))
                        .map_err(|value| value.to_string())?;
                    current = Some(ActiveWriter {
                        path: config.path,
                        frames: 0,
                        sample_rate,
                        channel_count: configured_channels,
                        writer: writer
                            .audio_frame_writer()
                            .map_err(|value| value.to_string())?,
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
                        write_available(&mut consumer, &mut writer, &mut scratch, &waveform)?;
                    }
                    let path = writer.path.clone();
                    let frames = writer.frames;
                    writer.writer.end().map_err(|value| value.to_string())?;
                    OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&path)
                        .and_then(|file| file.sync_all())
                        .map_err(|value| value.to_string())?;
                    Ok(NativeRecordingResult {
                        path,
                        sample_rate: writer.sample_rate,
                        channels: writer.channel_count as u32,
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
                        let _ =
                            write_available(&mut consumer, &mut writer, &mut scratch, &waveform);
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

pub struct RecorderController {
    sender: Sender<WriterCommand>,
    active: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    waveform: Arc<Mutex<LiveWaveform>>,
}

impl RecorderController {
    pub fn new(
        sample_rate: u32,
        transport_state: Arc<AtomicU32>,
        recording_state: u32,
    ) -> (Self, RecordingTap) {
        let ring =
            HeapRb::<InputFrame>::new((sample_rate as usize * RECORDING_RING_SECONDS).max(8_192));
        let (producer, consumer) = ring.split();
        let active = Arc::new(AtomicBool::new(false));
        let dropout_frames = Arc::new(AtomicU64::new(0));
        let channel_count = Arc::new(AtomicU32::new(0));
        let (sender, receiver) = mpsc::channel();
        let waveform = Arc::new(Mutex::new(LiveWaveform::default()));
        let thread = thread::Builder::new()
            .name("heron-recording-writer".to_owned())
            .spawn({
                let active = Arc::clone(&active);
                let dropout_frames = Arc::clone(&dropout_frames);
                let waveform = Arc::clone(&waveform);
                let channel_count = Arc::clone(&channel_count);
                move || {
                    writer_thread(
                        consumer,
                        receiver,
                        active,
                        dropout_frames,
                        channel_count,
                        waveform,
                    );
                }
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
                transport_state,
                recording_state,
            },
        )
    }

    pub fn start(&self, config: NativeRecordingStartConfig) -> HostResult<()> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(WriterCommand::Start { config, reply })
            .map_err(|value| error("recording writer stopped", value))?;
        response
            .recv()
            .map_err(|value| error("recording writer stopped", value))?
            .map_err(|value| error("failed to start recording", value))
    }

    pub fn stop(&self) -> HostResult<NativeRecordingResult> {
        self.active.store(false, Ordering::Release);
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(WriterCommand::Stop { reply })
            .map_err(|value| error("recording writer stopped", value))?;
        response
            .recv()
            .map_err(|value| error("recording writer stopped", value))?
            .map_err(|value| error("failed to stop recording", value))
    }

    pub fn waveform_snapshot(
        &self,
        start_frame: i64,
        end_frame: i64,
        max_buckets: u32,
    ) -> HostResult<NativeWaveformSnapshot> {
        if start_frame < 0 || end_frame < start_frame || max_buckets == 0 {
            return Err(HostError::new(
                Status::InvalidArg,
                "invalid waveform window",
            ));
        }
        Ok(self
            .waveform
            .lock()
            .map_err(|_| error("waveform state", "poisoned"))?
            .snapshot(
                start_frame as usize,
                end_frame as usize,
                max_buckets as usize,
            ))
    }
}

impl Drop for RecorderController {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        let _ = self.sender.send(WriterCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
pub fn write_deterministic_test_recording(
    config: NativeRecordingStartConfig,
    sample_rate: u32,
    frame_count: u32,
) -> HostResult<NativeRecordingResult> {
    if sample_rate == 0 || frame_count == 0 {
        return Err(HostError::new(
            Status::InvalidArg,
            "test recording sample rate and frame count must be positive",
        ));
    }
    let mut writer = WaveWriter::create(&config.path, float_format(sample_rate, 2))
        .map_err(|value| error("failed to create deterministic recording", value))?;
    writer
        .write_broadcast_metadata(&metadata(&config, sample_rate, 2))
        .map_err(|value| error("failed to write deterministic BWF metadata", value))?;
    let mut samples = Vec::with_capacity(frame_count as usize * 2);
    for frame in 0..frame_count {
        let sample =
            (std::f32::consts::TAU * 1_000.0 * frame as f32 / sample_rate as f32).sin() * 0.25;
        samples.extend_from_slice(&[sample, sample]);
    }
    let mut audio = writer
        .audio_frame_writer()
        .map_err(|value| error("failed to start deterministic BWF audio", value))?;
    audio
        .write_frames(&samples)
        .map_err(|value| error("failed to write deterministic BWF audio", value))?;
    audio
        .end()
        .map_err(|value| error("failed to finalize deterministic BWF", value))?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&config.path)
        .and_then(|file| file.sync_all())
        .map_err(|value| error("failed to flush deterministic BWF", value))?;
    Ok(NativeRecordingResult {
        path: config.path,
        sample_rate,
        channels: 2,
        frame_count: i64::from(frame_count),
        dropout_frames: 0,
    })
}

#[cfg(test)]
#[allow(clippy::wildcard_imports)]
mod tests {
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    const TRANSPORT_RECORDING: u32 = 2;
    const TRANSPORT_COUNTING_IN: u32 = 4;

    fn temporary_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time moves forward")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "heron-recording-{label}-{}-{nonce}.bwf",
            std::process::id()
        ))
    }

    fn start_config(path: &std::path::Path) -> NativeRecordingStartConfig {
        NativeRecordingStartConfig {
            path: path.to_string_lossy().into_owned(),
            asset_id: "asset-42".to_owned(),
            originator: "Heron test".to_owned(),
            origination_date: "2026-07-31".to_owned(),
            origination_time: "16:00:00".to_owned(),
            time_reference: -7,
            sample_rate: 8_000,
            channels: 2,
        }
    }

    fn decode_peaks(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect()
    }

    fn recording_controller(
        sample_rate: u32,
        _channel_count: usize,
    ) -> (RecorderController, RecordingTap) {
        RecorderController::new(
            sample_rate,
            Arc::new(AtomicU32::new(TRANSPORT_RECORDING)),
            TRANSPORT_RECORDING,
        )
    }

    #[test]
    fn finite_sample_clamps_and_replaces_non_finite_values() {
        assert_eq!(finite_sample(0.5), 0.5);
        assert_eq!(finite_sample(2.0), 1.0);
        assert_eq!(finite_sample(-2.0), -1.0);
        assert_eq!(finite_sample(f32::NAN), 0.0);
        assert_eq!(finite_sample(f32::INFINITY), 0.0);
        assert_eq!(finite_sample(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn encode_peaks_writes_little_endian_f32_bytes() {
        assert!(encode_peaks(&[]).is_empty());
        let encoded = encode_peaks(&[1.0, -0.5]);
        assert_eq!(encoded.len(), 8);
        assert_eq!(&encoded[..4], &1.0_f32.to_le_bytes());
        assert_eq!(&encoded[4..], &(-0.5_f32).to_le_bytes());
    }

    #[test]
    fn aggregate_peak_level_reduces_groups_of_four_buckets() {
        // 4 buckets × 1 channel × (min, max)
        let source = [
            -0.1, 0.2, // bucket 0
            -0.4, 0.1, // bucket 1
            -0.2, 0.5, // bucket 2
            -0.3, 0.3, // bucket 3
        ];
        let aggregated = aggregate_peak_level(&source, 1);
        assert_eq!(aggregated, vec![-0.4, 0.5]);
    }

    #[test]
    fn aggregate_peak_level_handles_partial_trailing_group() {
        // 5 buckets → one full group of 4, then a remainder of 1
        let source = [
            -0.1, 0.1, -0.2, 0.2, -0.3, 0.3, -0.4, 0.4, // group 0
            -0.9, 0.8, // group 1 (partial)
        ];
        let aggregated = aggregate_peak_level(&source, 1);
        assert_eq!(aggregated, vec![-0.4, 0.4, -0.9, 0.8]);
    }

    #[test]
    fn aggregate_peak_level_preserves_multichannel_extrema() {
        // 4 buckets × 2 channels × (min, max)
        let source = [
            -0.1, 0.2, -0.5, 0.1, // bucket 0 L/R
            -0.4, 0.1, -0.2, 0.6, // bucket 1
            -0.2, 0.5, -0.7, 0.3, // bucket 2
            -0.3, 0.3, -0.1, 0.4, // bucket 3
        ];
        let aggregated = aggregate_peak_level(&source, 2);
        assert_eq!(aggregated, vec![-0.4, 0.5, -0.7, 0.6]);
    }

    #[test]
    fn float_format_clamps_channels_and_sets_float_pcm_fields() {
        let format = float_format(48_000, 2);
        assert_eq!(format.tag, WAVE_TAG_FLOAT);
        assert_eq!(format.channel_count, 2);
        assert_eq!(format.sample_rate, 48_000);
        assert_eq!(format.bits_per_sample, 32);
        assert_eq!(format.block_alignment, 8);
        assert_eq!(format.bytes_per_second, 48_000 * 8);
        assert!(format.extended_format.is_none());

        let mono = float_format(44_100, 0);
        assert_eq!(mono.channel_count, 1);
        assert_eq!(mono.block_alignment, 4);
    }

    #[test]
    fn metadata_copies_identity_fields_and_clamps_negative_time_reference() {
        let path = temporary_path("metadata");
        let config = start_config(&path);
        let bext = metadata(&config, 48_000, 2);
        assert!(bext.description.contains("asset-42"));
        assert_eq!(bext.originator, "Heron test");
        assert_eq!(bext.originator_reference, "asset-42");
        assert_eq!(bext.origination_date, "2026-07-31");
        assert_eq!(bext.origination_time, "16:00:00");
        assert_eq!(bext.time_reference, 0);
        assert_eq!(bext.version, 1);
        assert!(bext.coding_history.contains("F=48000"));
        assert!(bext.coding_history.contains("M=2 channel"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn live_waveform_sanitizes_samples_and_keeps_partial_bucket() {
        let mut waveform = LiveWaveform::default();
        waveform.reset(48_000, 2);
        let mut samples = vec![0.0_f32; WAVEFORM_BASE_FRAMES * 2];
        samples[0] = -0.75;
        samples[1] = 0.5;
        samples[2] = f32::NAN;
        samples[3] = f32::INFINITY;
        samples[(WAVEFORM_BASE_FRAMES - 1) * 2] = 0.25;
        samples[(WAVEFORM_BASE_FRAMES - 1) * 2 + 1] = -0.25;
        waveform.push(&samples);
        // One extra partial bucket frame.
        waveform.push(&[0.9, -0.9]);

        let snapshot = waveform.snapshot(0, waveform.frame_count, 16);
        assert_eq!(snapshot.sample_rate, 48_000);
        assert_eq!(snapshot.channels, 2);
        assert_eq!(snapshot.frame_count, (WAVEFORM_BASE_FRAMES + 1) as i64);
        assert_eq!(snapshot.bucket_count, 2);
        let peaks = decode_peaks(&snapshot.peaks);
        assert_eq!(peaks.len(), 8);
        assert_eq!(peaks[0], -0.75);
        assert_eq!(peaks[1], 0.25);
        assert_eq!(peaks[2], -0.25);
        assert_eq!(peaks[3], 0.5);
        assert_eq!(peaks[4], 0.9);
        assert_eq!(peaks[5], 0.9);
        assert_eq!(peaks[6], -0.9);
        assert_eq!(peaks[7], -0.9);
    }

    #[test]
    fn live_waveform_aggregates_when_max_buckets_is_small() {
        let mut waveform = LiveWaveform::default();
        waveform.reset(48_000, 1);
        let frames = WAVEFORM_BASE_FRAMES * WAVEFORM_LEVEL_FACTOR * 2;
        waveform.push(&vec![0.5_f32; frames]);
        let snapshot = waveform.snapshot(0, frames, 1);
        assert_eq!(snapshot.bucket_count, 1);
        assert!(snapshot.frames_per_bucket >= WAVEFORM_BASE_FRAMES as u32);
        let peaks = decode_peaks(&snapshot.peaks);
        assert_eq!(peaks, vec![0.5, 0.5]);
    }

    #[test]
    fn recording_tap_ignores_inactive_pushes_and_counts_dropouts() {
        let (controller, mut tap) = recording_controller(8_000, 2);
        tap.push(&[0.1, -0.1]);
        assert_eq!(tap.dropout_frames.load(Ordering::Relaxed), 0);

        // Activate the tap flag without opening a writer so the ring can fill.
        controller.active.store(true, Ordering::Release);
        for _ in 0..100_000 {
            tap.push(&[0.25, -0.25]);
        }
        assert!(tap.dropout_frames.load(Ordering::Relaxed) > 0);
        drop(controller);
    }

    #[test]
    fn recorder_controller_writes_and_snapshots_waveform_via_tempdir() {
        let path = temporary_path("controller");
        let (controller, mut tap) = recording_controller(8_000, 2);
        controller
            .start(start_config(&path))
            .expect("start recording");
        for _ in 0..(WAVEFORM_BASE_FRAMES + 8) {
            tap.push(&[0.5, -0.25]);
        }
        // Allow the writer thread to drain the ring.
        std::thread::sleep(Duration::from_millis(50));
        let snapshot = controller
            .waveform_snapshot(0, 10_000, 8)
            .expect("waveform snapshot");
        assert_eq!(snapshot.channels, 2);
        assert!(snapshot.frame_count > 0);
        assert!(snapshot.bucket_count > 0);

        assert!(
            controller
                .waveform_snapshot(-1, 10, 8)
                .is_err_and(|error| error.to_string().contains("invalid waveform window"))
        );
        assert!(controller.waveform_snapshot(10, 9, 8).is_err());
        assert!(controller.waveform_snapshot(0, 10, 0).is_err());

        let result = controller.stop().expect("stop recording");
        assert_eq!(result.path, path.to_string_lossy());
        assert_eq!(result.sample_rate, 8_000);
        assert_eq!(result.channels, 2);
        assert!(result.frame_count >= WAVEFORM_BASE_FRAMES as i64);
        assert!(path.exists());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn recorder_controller_rejects_double_start_and_stop_without_start() {
        let path = temporary_path("double-start");
        let (controller, _tap) = recording_controller(8_000, 1);
        assert!(controller.stop().is_err());
        controller.start(start_config(&path)).expect("first start");
        assert!(controller.start(start_config(&path)).is_err());
        let _ = controller.stop();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_deterministic_test_recording_rejects_zero_and_writes_bwf() {
        let path = temporary_path("deterministic");
        let config = start_config(&path);
        assert!(write_deterministic_test_recording(config.clone(), 0, 16).is_err());
        assert!(write_deterministic_test_recording(config.clone(), 8_000, 0).is_err());
        let result =
            write_deterministic_test_recording(config, 8_000, 32).expect("deterministic write");
        assert_eq!(result.frame_count, 32);
        assert_eq!(result.channels, 2);
        assert_eq!(result.dropout_frames, 0);
        assert!(path.exists());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn recording_tap_ignores_input_until_transport_is_recording() {
        let ring = HeapRb::<InputFrame>::new(4);
        let (producer, mut consumer) = ring.split();
        let active = Arc::new(AtomicBool::new(true));
        let transport_state = Arc::new(AtomicU32::new(TRANSPORT_COUNTING_IN));
        let mut tap = RecordingTap {
            producer,
            active,
            dropout_frames: Arc::new(AtomicU64::new(0)),
            channel_count: Arc::new(AtomicU32::new(2)),
            transport_state: Arc::clone(&transport_state),
            recording_state: TRANSPORT_RECORDING,
        };

        tap.push(&[0.25, -0.25]);
        assert!(consumer.try_pop().is_none());

        transport_state.store(TRANSPORT_RECORDING, Ordering::Relaxed);
        tap.push(&[0.25, -0.25]);
        assert_eq!(
            consumer.try_pop().map(|frame| [frame[0], frame[1]]),
            Some([0.25, -0.25])
        );
    }
}
