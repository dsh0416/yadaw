use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
};
#[cfg(any(test, feature = "bench-internals"))]
use std::{
    io::BufWriter,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[cfg(any(test, feature = "bench-internals"))]
use bwavfile::AudioFrameWriter;
use bwavfile::{Bext, WAVE_TAG_FLOAT, WaveFmt, WaveReader, WaveWriter};
use napi::{Error, Result, Status, Task, bindgen_prelude::Buffer};
use napi_derive::napi;
#[cfg(any(test, feature = "bench-internals"))]
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};
use rubato::{Fft, FixedSync, Resampler, audioadapter_buffers::direct::InterleavedSlice};
use sha2::{Digest, Sha256};

#[cfg(any(test, feature = "bench-internals"))]
#[allow(dead_code)]
pub type StereoFrame = [f32; 2];
#[cfg(any(test, feature = "bench-internals"))]
pub const MAX_INPUT_CHANNELS: usize = 32;
#[cfg(any(test, feature = "bench-internals"))]
pub type InputFrame = [f32; MAX_INPUT_CHANNELS];

#[cfg(any(test, feature = "bench-internals"))]
const RECORDING_RING_SECONDS: usize = 8;
#[cfg(any(test, feature = "bench-internals"))]
const WRITER_BLOCK_FRAMES: usize = 2_048;
const WAVEFORM_BASE_FRAMES: usize = 64;
const WAVEFORM_LEVEL_FACTOR: usize = 4;

#[napi(object)]
pub struct NativeWaveformLevel {
    pub frames_per_bucket: u32,
    pub bucket_count: u32,
    pub peaks: Buffer,
}

#[napi(object)]
#[cfg(any(test, feature = "bench-internals"))]
pub struct NativeWaveformSnapshot {
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub start_frame: i64,
    pub end_frame: i64,
    pub frames_per_bucket: u32,
    pub bucket_count: u32,
    pub peaks: Buffer,
}

#[napi(object)]
pub struct NativeAnalyzedWaveform {
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub waveform_levels: Vec<NativeWaveformLevel>,
}

#[napi(object)]
pub struct NativeRecordingStartConfig {
    pub path: String,
    pub asset_id: String,
    pub originator: String,
    pub origination_date: String,
    pub origination_time: String,
    pub time_reference: i64,
}

#[napi(object)]
pub struct NativeRecordingResult {
    pub path: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub dropout_frames: i64,
}

#[napi(object)]
pub struct NativeFinalizeRecordingConfig {
    pub input_path: String,
    pub output_path: String,
    pub target_sample_rate: u32,
    pub bit_depth: String,
    pub asset_id: String,
    pub originator: String,
    pub origination_date: String,
    pub origination_time: String,
    pub time_reference: i64,
    pub channel_indices: Option<Vec<u32>>,
}

#[napi(object)]
pub struct NativeFinalizedRecording {
    pub path: String,
    pub content_hash: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_depth: String,
    pub frame_count: i64,
    pub time_reference: i64,
    pub waveform_levels: Vec<NativeWaveformLevel>,
}

fn finite_sample(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn encode_peaks(values: &[f32]) -> Buffer {
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(values));
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.into()
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

fn base_peak_level(samples: &[f32], channels: usize) -> Vec<f32> {
    let frames = samples.len() / channels;
    let mut peaks = Vec::with_capacity(frames.div_ceil(WAVEFORM_BASE_FRAMES) * channels * 2);
    for start in (0..frames).step_by(WAVEFORM_BASE_FRAMES) {
        let end = (start + WAVEFORM_BASE_FRAMES).min(frames);
        for channel in 0..channels {
            let mut minimum = 1.0_f32;
            let mut maximum = -1.0_f32;
            for frame in start..end {
                let sample = finite_sample(samples[frame * channels + channel]);
                minimum = minimum.min(sample);
                maximum = maximum.max(sample);
            }
            peaks.extend_from_slice(&[minimum, maximum]);
        }
    }
    peaks
}

fn build_waveform_levels(samples: &[f32], channels: usize) -> Vec<NativeWaveformLevel> {
    if channels == 0 || samples.is_empty() {
        return Vec::new();
    }
    let mut frames_per_bucket = WAVEFORM_BASE_FRAMES;
    let mut values = base_peak_level(samples, channels);
    let mut result = Vec::new();
    loop {
        let bucket_count = values.len() / (channels * 2);
        result.push(NativeWaveformLevel {
            frames_per_bucket: frames_per_bucket as u32,
            bucket_count: bucket_count as u32,
            peaks: encode_peaks(&values),
        });
        if bucket_count <= 1 {
            break;
        }
        values = aggregate_peak_level(&values, channels);
        frames_per_bucket *= WAVEFORM_LEVEL_FACTOR;
    }
    result
}

#[derive(Default)]
#[cfg(any(test, feature = "bench-internals"))]
struct LiveWaveform {
    sample_rate: u32,
    channels: usize,
    frame_count: usize,
    base_peaks: Vec<f32>,
    pending_peaks: Vec<f32>,
    pending_frames: usize,
}

#[cfg(any(test, feature = "bench-internals"))]
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
        if self.channels == 0 {
            return;
        }
        for frame in samples.chunks_exact(self.channels) {
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

    fn snapshot(
        &self,
        start_frame: usize,
        end_frame: usize,
        max_buckets: usize,
    ) -> NativeWaveformSnapshot {
        let end = end_frame
            .min(self.frame_count)
            .max(start_frame.min(self.frame_count));
        let start = start_frame.min(end);
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
        let bucket_count = values.len() / stride.max(1);
        let coverage_start = first_bucket * WAVEFORM_BASE_FRAMES;
        let coverage_end = (last_bucket * WAVEFORM_BASE_FRAMES).min(self.frame_count);
        NativeWaveformSnapshot {
            sample_rate: self.sample_rate,
            channels: self.channels as u32,
            frame_count: self.frame_count.min(i64::MAX as usize) as i64,
            start_frame: coverage_start.min(i64::MAX as usize) as i64,
            end_frame: coverage_end.min(i64::MAX as usize) as i64,
            frames_per_bucket: frames_per_bucket as u32,
            bucket_count: bucket_count as u32,
            peaks: encode_peaks(&values),
        }
    }
}

fn recording_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
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

fn float_stereo_format(sample_rate: u32) -> WaveFmt {
    float_format(sample_rate, 2)
}

fn pcm_stereo_format(sample_rate: u32, bits_per_sample: u16) -> WaveFmt {
    WaveFmt::new_pcm_stereo(sample_rate, bits_per_sample)
}

fn broadcast_metadata(
    asset_id: &str,
    originator: &str,
    origination_date: &str,
    origination_time: &str,
    time_reference: u64,
    coding_history: String,
) -> Bext {
    Bext {
        description: format!("YADAW recording {asset_id}"),
        originator: originator.to_owned(),
        originator_reference: asset_id.to_owned(),
        origination_date: origination_date.to_owned(),
        origination_time: origination_time.to_owned(),
        time_reference,
        version: 1,
        umid: None,
        loudness_value: None,
        loudness_range: None,
        max_true_peak_level: None,
        max_momentary_loudness: None,
        max_short_term_loudness: None,
        coding_history,
    }
}

#[cfg(any(test, feature = "bench-internals"))]
pub struct RecordingTap {
    producer: HeapProd<InputFrame>,
    active: Arc<AtomicBool>,
    dropout_frames: Arc<AtomicU64>,
    channel_count: usize,
}

#[cfg(any(test, feature = "bench-internals"))]
impl RecordingTap {
    pub fn push(&mut self, channels: &[f32]) {
        if !self.active.load(Ordering::Relaxed) {
            return;
        }
        let mut frame = [0.0_f32; MAX_INPUT_CHANNELS];
        let count = channels
            .len()
            .min(self.channel_count)
            .min(MAX_INPUT_CHANNELS);
        frame[..count].copy_from_slice(&channels[..count]);
        if self.producer.try_push(frame).is_err() {
            self.dropout_frames.fetch_add(1, Ordering::Relaxed);
        }
    }
}

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

struct TpdfDither {
    state: u64,
}

impl TpdfDither {
    fn new(seed: &[u8]) -> Self {
        let digest = Sha256::digest(seed);
        let mut value = [0_u8; 8];
        value.copy_from_slice(&digest[..8]);
        Self {
            state: u64::from_le_bytes(value).max(1),
        }
    }

    fn uniform(&mut self) -> f32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        (self.state >> 40) as f32 / (1_u32 << 24) as f32
    }

    fn apply(&mut self, sample: f32, bits: u32) -> f32 {
        let lsb = 1.0 / (1_u32 << (bits - 1)) as f32;
        (sample + (self.uniform() - self.uniform()) * lsb).clamp(-1.0, 1.0 - lsb)
    }
}

fn finalize(config: &NativeFinalizeRecordingConfig) -> Result<NativeFinalizedRecording> {
    if config.target_sample_rate == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "target sample rate must be positive",
        ));
    }
    let mut reader = WaveReader::open(&config.input_path)
        .map_err(|error| recording_error("failed to open swap recording", error))?;
    let source_format = reader
        .format()
        .map_err(|error| recording_error("failed to read swap format", error))?;
    let source_frames = reader
        .frame_length()
        .map_err(|error| recording_error("failed to read swap length", error))?
        as usize;
    let source_channels = source_format.channel_count as usize;
    if source_channels == 0 {
        return Err(Error::new(Status::InvalidArg, "recording has no channels"));
    }
    let mut samples = vec![0.0_f32; source_frames * source_channels];
    let mut frame_reader = reader
        .audio_frame_reader()
        .map_err(|error| recording_error("failed to open swap audio", error))?;
    let read_frames = frame_reader
        .read_frames(&mut samples)
        .map_err(|error| recording_error("failed to read swap audio", error))?
        as usize;
    samples.truncate(read_frames * source_channels);
    let selected_channels = config.channel_indices.as_ref().map_or_else(
        || (0..source_channels).collect::<Vec<_>>(),
        |indices| {
            indices
                .iter()
                .map(|index| index.saturating_sub(1) as usize)
                .collect()
        },
    );
    if selected_channels.is_empty()
        || selected_channels.len() > 2
        || selected_channels
            .iter()
            .any(|&index| index >= source_channels)
    {
        return Err(Error::new(
            Status::InvalidArg,
            "recording route must select one or two available input channels",
        ));
    }
    let channels = selected_channels.len();
    if selected_channels != (0..source_channels).collect::<Vec<_>>() {
        let mut routed = Vec::with_capacity(read_frames * channels);
        for frame in samples.chunks_exact(source_channels) {
            for &index in &selected_channels {
                routed.push(frame[index]);
            }
        }
        samples = routed;
    }

    let processed = if source_format.sample_rate == config.target_sample_rate {
        samples
    } else {
        let mut resampler = Fft::<f32>::new(
            source_format.sample_rate as usize,
            config.target_sample_rate as usize,
            8_192,
            channels,
            FixedSync::Input,
        )
        .map_err(|error| recording_error("failed to create offline resampler", error))?;
        let adapter = InterleavedSlice::new(&samples, channels, read_frames)
            .map_err(|error| recording_error("failed to adapt recording buffer", error))?;
        resampler
            .process_all(&adapter, read_frames, None)
            .map_err(|error| recording_error("failed to resample recording", error))?
            .take_data()
    };

    let bits = match config.bit_depth.as_str() {
        "float32" => 32,
        "pcm24" => 24,
        "pcm16" => 16,
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                "unsupported recording bit depth",
            ));
        }
    };
    let format = if config.bit_depth == "float32" {
        WaveFmt {
            tag: WAVE_TAG_FLOAT,
            channel_count: channels as u16,
            sample_rate: config.target_sample_rate,
            bytes_per_second: config.target_sample_rate * channels as u32 * 4,
            block_alignment: channels as u16 * 4,
            bits_per_sample: 32,
            extended_format: None,
        }
    } else if channels == 2 {
        pcm_stereo_format(config.target_sample_rate, bits)
    } else if channels == 1 {
        WaveFmt::new_pcm_mono(config.target_sample_rate, bits)
    } else {
        return Err(Error::new(
            Status::InvalidArg,
            "only mono and stereo recordings are supported",
        ));
    };
    let mut writer = WaveWriter::create(&config.output_path, format)
        .map_err(|error| recording_error("failed to create final BWF", error))?;
    writer
        .write_broadcast_metadata(&broadcast_metadata(
            &config.asset_id,
            &config.originator,
            &config.origination_date,
            &config.origination_time,
            config.time_reference.max(0) as u64,
            format!(
                "A=PCM,F={},W=32,M={} channel,T=YADAW swap\r\nA=PCM,F={},W={},T=Fft SRC + final quantization\r\n",
                source_format.sample_rate, channels, config.target_sample_rate, bits
            ),
        ))
        .map_err(|error| recording_error("failed to write BWF metadata", error))?;
    let final_samples = if config.bit_depth == "float32" {
        processed
    } else {
        let mut dither = TpdfDither::new(config.asset_id.as_bytes());
        processed
            .iter()
            .map(|sample| dither.apply(*sample, bits as u32))
            .collect()
    };
    let mut audio = writer
        .audio_frame_writer()
        .map_err(|error| recording_error("failed to start final BWF audio", error))?;
    audio
        .write_frames(&final_samples)
        .map_err(|error| recording_error("failed to write final recording", error))?;
    audio
        .end()
        .map_err(|error| recording_error("failed to finalize BWF", error))?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&config.output_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| recording_error("failed to flush final BWF", error))?;
    // Read the encoded file back so PCM16/PCM24 peak caches describe the exact
    // quantized samples on disk, not their pre-quantization floating values.
    let analyzed = analyze_waveform_path(&config.output_path)?;

    let mut file = File::open(&config.output_path)
        .map_err(|error| recording_error("failed to hash final BWF", error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| recording_error("failed to hash final BWF", error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(NativeFinalizedRecording {
        path: config.output_path.clone(),
        content_hash: format!("{:x}", hasher.finalize()),
        sample_rate: config.target_sample_rate,
        channels: channels as u32,
        bit_depth: config.bit_depth.clone(),
        frame_count: analyzed.frame_count,
        time_reference: config.time_reference.max(0),
        waveform_levels: analyzed.waveform_levels,
    })
}

fn analyze_waveform_path(path: &str) -> Result<NativeAnalyzedWaveform> {
    let mut reader = WaveReader::open(path)
        .map_err(|error| recording_error("failed to open waveform source", error))?;
    let format = reader
        .format()
        .map_err(|error| recording_error("failed to read waveform format", error))?;
    let frame_count = reader
        .frame_length()
        .map_err(|error| recording_error("failed to read waveform length", error))?
        as usize;
    let channels = format.channel_count as usize;
    if channels == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "waveform source has no channels",
        ));
    }
    let mut samples = vec![0.0_f32; frame_count * channels];
    let mut frame_reader = reader
        .audio_frame_reader()
        .map_err(|error| recording_error("failed to open waveform audio", error))?;
    let read_frames = frame_reader
        .read_frames(&mut samples)
        .map_err(|error| recording_error("failed to read waveform audio", error))?
        as usize;
    samples.truncate(read_frames * channels);
    Ok(NativeAnalyzedWaveform {
        sample_rate: format.sample_rate,
        channels: channels as u32,
        frame_count: read_frames.min(i64::MAX as usize) as i64,
        waveform_levels: build_waveform_levels(&samples, channels),
    })
}

pub struct AnalyzeWaveformTask {
    path: String,
}

#[napi]
impl Task for AnalyzeWaveformTask {
    type Output = NativeAnalyzedWaveform;
    type JsValue = NativeAnalyzedWaveform;

    fn compute(&mut self) -> Result<Self::Output> {
        analyze_waveform_path(&self.path)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn analyze_waveform(path: String) -> napi::bindgen_prelude::AsyncTask<AnalyzeWaveformTask> {
    napi::bindgen_prelude::AsyncTask::new(AnalyzeWaveformTask { path })
}

pub struct FinalizeRecordingTask {
    config: NativeFinalizeRecordingConfig,
}

#[napi]
impl Task for FinalizeRecordingTask {
    type Output = NativeFinalizedRecording;
    type JsValue = NativeFinalizedRecording;

    fn compute(&mut self) -> Result<Self::Output> {
        finalize(&self.config)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn finalize_recording(
    config: NativeFinalizeRecordingConfig,
) -> napi::bindgen_prelude::AsyncTask<FinalizeRecordingTask> {
    napi::bindgen_prelude::AsyncTask::new(FinalizeRecordingTask { config })
}

#[napi]
pub fn write_deterministic_test_recording(
    config: NativeRecordingStartConfig,
    sample_rate: u32,
    frame_count: u32,
) -> Result<NativeRecordingResult> {
    if sample_rate == 0 || frame_count == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "test recording sample rate and frame count must be positive",
        ));
    }
    let mut writer = WaveWriter::create(&config.path, float_stereo_format(sample_rate))
        .map_err(|error| recording_error("failed to create deterministic recording", error))?;
    writer
        .write_broadcast_metadata(&broadcast_metadata(
            &config.asset_id,
            &config.originator,
            &config.origination_date,
            &config.origination_time,
            config.time_reference.max(0) as u64,
            format!("A=PCM,F={sample_rate},W=32,M=stereo,T=YADAW deterministic test source\r\n"),
        ))
        .map_err(|error| recording_error("failed to write deterministic BWF metadata", error))?;
    let mut samples = Vec::with_capacity(frame_count as usize * 2);
    for frame in 0..frame_count {
        let sample =
            (std::f32::consts::TAU * 1_000.0 * frame as f32 / sample_rate as f32).sin() * 0.25;
        samples.extend_from_slice(&[sample, sample]);
    }
    let mut audio = writer
        .audio_frame_writer()
        .map_err(|error| recording_error("failed to start deterministic BWF audio", error))?;
    audio
        .write_frames(&samples)
        .map_err(|error| recording_error("failed to write deterministic BWF audio", error))?;
    audio
        .end()
        .map_err(|error| recording_error("failed to finalize deterministic BWF", error))?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&config.path)
        .and_then(|file| file.sync_all())
        .map_err(|error| recording_error("failed to flush deterministic BWF", error))?;
    Ok(NativeRecordingResult {
        path: config.path,
        sample_rate,
        channels: 2,
        frame_count: i64::from(frame_count),
        dropout_frames: 0,
    })
}

#[napi]
pub fn repair_recording_header(path: String, channels: u32) -> Result<i64> {
    if channels == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "channel count must be positive",
        ));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| recording_error("failed to open partial recording", error))?;
    let file_length = file
        .metadata()
        .map_err(|error| recording_error("failed to inspect partial recording", error))?
        .len();
    let mut signature = [0_u8; 12];
    file.read_exact(&mut signature)
        .map_err(|error| recording_error("partial recording header is incomplete", error))?;
    if &signature[0..4] != b"RIFF" && &signature[0..4] != b"RF64" {
        return Err(Error::new(
            Status::InvalidArg,
            "partial recording is not RIFF/RF64",
        ));
    }
    if &signature[8..12] != b"WAVE" {
        return Err(Error::new(
            Status::InvalidArg,
            "partial recording is not WAVE",
        ));
    }

    let mut position = 12_u64;
    let mut data_size_offset = None;
    let mut data_start = None;
    while position + 8 <= file_length {
        file.seek(SeekFrom::Start(position))
            .map_err(|error| recording_error("failed to seek partial recording", error))?;
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)
            .map_err(|error| recording_error("partial recording chunk is incomplete", error))?;
        let chunk_size = u32::from_le_bytes(header[4..8].try_into().expect("four bytes")) as u64;
        if &header[0..4] == b"data" {
            data_size_offset = Some(position + 4);
            data_start = Some(position + 8);
            break;
        }
        position = position
            .checked_add(8 + chunk_size + (chunk_size & 1))
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "partial recording chunk length overflow",
                )
            })?;
    }
    let data_start = data_start
        .ok_or_else(|| Error::new(Status::InvalidArg, "partial recording has no data chunk"))?;
    let data_size_offset = data_size_offset.expect("data offset accompanies data start");
    let data_size = file_length.saturating_sub(data_start);
    let block_alignment = u64::from(channels) * 4;
    let frame_count = data_size / block_alignment;

    if file_length - 8 <= u32::MAX as u64 && data_size <= u32::MAX as u64 {
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(b"RIFF"))
            .and_then(|_| file.write_all(&((file_length - 8) as u32).to_le_bytes()))
            .and_then(|_| file.seek(SeekFrom::Start(data_size_offset)))
            .and_then(|_| file.write_all(&(data_size as u32).to_le_bytes()))
            .map_err(|error| recording_error("failed to repair RIFF lengths", error))?;
    } else {
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(b"RF64"))
            .and_then(|_| file.write_all(&u32::MAX.to_le_bytes()))
            .and_then(|_| file.seek(SeekFrom::Start(12)))
            .and_then(|_| file.write_all(b"ds64"))
            .and_then(|_| file.write_all(&28_u32.to_le_bytes()))
            .and_then(|_| file.write_all(&(file_length - 8).to_le_bytes()))
            .and_then(|_| file.write_all(&data_size.to_le_bytes()))
            .and_then(|_| file.write_all(&frame_count.to_le_bytes()))
            .and_then(|_| file.write_all(&0_u32.to_le_bytes()))
            .and_then(|_| file.seek(SeekFrom::Start(data_size_offset)))
            .and_then(|_| file.write_all(&u32::MAX.to_le_bytes()))
            .map_err(|error| recording_error("failed to repair RF64 lengths", error))?;
    }
    file.sync_all()
        .map_err(|error| recording_error("failed to flush repaired recording", error))?;
    Ok(frame_count.min(i64::MAX as u64) as i64)
}

#[cfg(feature = "bench-internals")]
#[doc(hidden)]
pub mod bench_support {
    use std::{
        f32::consts::TAU,
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicU64},
        },
    };

    use bwavfile::{WaveFmt, WaveWriter};
    use ringbuf::{
        HeapCons, HeapRb,
        traits::{Consumer, Split},
    };

    use super::{
        InputFrame, LiveWaveform, MAX_INPUT_CHANNELS, NativeFinalizeRecordingConfig,
        NativeRecordingStartConfig, RecorderController, RecordingTap, finalize, float_format,
    };

    pub fn write_float_fixture(
        path: &Path,
        sample_rate: u32,
        channels: usize,
        frames: usize,
    ) -> u64 {
        let channels = channels.clamp(1, MAX_INPUT_CHANNELS);
        let format: WaveFmt = float_format(sample_rate, channels);
        let writer = WaveWriter::create(path, format).expect("create benchmark BWF fixture");
        let mut audio = writer
            .audio_frame_writer()
            .expect("start benchmark fixture audio");
        let mut samples = Vec::with_capacity(frames.saturating_mul(channels));
        for frame in 0..frames {
            let phase = frame as f32 / sample_rate as f32 * 440.0 * TAU;
            for channel in 0..channels {
                samples.push(phase.sin() * (0.25 - channel as f32 * 0.002));
            }
        }
        audio
            .write_frames(&samples)
            .expect("write benchmark fixture samples");
        audio.end().expect("finish benchmark fixture");
        std::fs::metadata(path)
            .expect("inspect benchmark fixture")
            .len()
    }

    pub struct TapHarness {
        tap: RecordingTap,
        consumer: HeapCons<InputFrame>,
        block: Vec<f32>,
        block_frames: usize,
        channel_count: usize,
    }

    impl TapHarness {
        pub fn new(channel_count: usize, block_frames: usize) -> Self {
            let channel_count = channel_count.clamp(1, MAX_INPUT_CHANNELS);
            let ring = HeapRb::<InputFrame>::new(block_frames.max(1) + 1);
            let (producer, consumer) = ring.split();
            let active = Arc::new(AtomicBool::new(true));
            let dropout_frames = Arc::new(AtomicU64::new(0));
            let tap = RecordingTap {
                producer,
                active,
                dropout_frames,
                channel_count,
            };
            let block = (0..block_frames.saturating_mul(channel_count))
                .map(|index| (index % 31) as f32 / 31.0 - 0.5)
                .collect();
            Self {
                tap,
                consumer,
                block,
                block_frames,
                channel_count,
            }
        }

        pub fn push_block(&mut self) {
            for frame in self.block.chunks_exact(self.channel_count) {
                self.tap.push(frame);
            }
        }

        pub fn drain(&mut self) -> usize {
            let mut frames = 0;
            while self.consumer.try_pop().is_some() {
                frames += 1;
            }
            frames
        }

        pub fn block_frames(&self) -> usize {
            self.block_frames
        }
    }

    pub struct WaveformHarness {
        waveform: LiveWaveform,
        samples: Vec<f32>,
    }

    impl WaveformHarness {
        pub fn new(sample_rate: u32, channels: usize, frames: usize) -> Self {
            let channels = channels.clamp(1, MAX_INPUT_CHANNELS);
            let mut waveform = LiveWaveform::default();
            waveform.reset(sample_rate, channels);
            let samples = (0..frames.saturating_mul(channels))
                .map(|index| (index % 101) as f32 / 101.0)
                .collect();
            Self { waveform, samples }
        }

        pub fn push(&mut self) {
            self.waveform.push(&self.samples);
        }
    }

    pub fn write_recording_session(
        path: &Path,
        sample_rate: u32,
        channels: usize,
        frames: usize,
        callback_frames: usize,
    ) -> i64 {
        let (controller, mut tap) = RecorderController::new(sample_rate, channels);
        controller
            .start(NativeRecordingStartConfig {
                path: path.to_string_lossy().into_owned(),
                asset_id: "benchmark-writer".to_owned(),
                originator: "YADAW benchmark".to_owned(),
                origination_date: "2026-01-01".to_owned(),
                origination_time: "00:00:00".to_owned(),
                time_reference: 0,
            })
            .expect("start benchmark recording");
        let channel_count = channels.clamp(1, MAX_INPUT_CHANNELS);
        let block = vec![0.125_f32; callback_frames.saturating_mul(channel_count)];
        let mut written = 0;
        while written < frames {
            let take = callback_frames.min(frames - written);
            for frame in block[..take * channel_count].chunks_exact(channel_count) {
                tap.push(frame);
            }
            written += take;
        }
        controller
            .stop()
            .expect("stop benchmark recording")
            .frame_count
    }

    pub fn finalize_fixture(
        input: &Path,
        output: &Path,
        target_sample_rate: u32,
        bit_depth: &str,
        channel_indices: Option<Vec<u32>>,
    ) -> i64 {
        finalize(&NativeFinalizeRecordingConfig {
            input_path: input.to_string_lossy().into_owned(),
            output_path: output.to_string_lossy().into_owned(),
            target_sample_rate,
            bit_depth: bit_depth.to_owned(),
            asset_id: format!("benchmark-{target_sample_rate}-{bit_depth}"),
            originator: "YADAW benchmark".to_owned(),
            origination_date: "2026-01-01".to_owned(),
            origination_time: "00:00:00".to_owned(),
            time_reference: 0,
            channel_indices,
        })
        .expect("finalize benchmark recording")
        .frame_count
    }
}

#[cfg(test)]
mod tests {
    use std::{
        f32::consts::TAU,
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use bwavfile::{WaveReader, WaveWriter};

    use super::{
        LiveWaveform, NativeFinalizeRecordingConfig, NativeRecordingStartConfig,
        RecorderController, TpdfDither, analyze_waveform_path, base_peak_level, broadcast_metadata,
        finalize, float_stereo_format, repair_recording_header,
    };

    fn temporary_file(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time moves forward")
            .as_nanos();
        std::env::temp_dir().join(format!("yadaw-{label}-{}-{nonce}.bwf", std::process::id()))
    }

    fn start_config(path: &std::path::Path) -> NativeRecordingStartConfig {
        NativeRecordingStartConfig {
            path: path.to_string_lossy().into_owned(),
            asset_id: "deterministic-asset".to_owned(),
            originator: "YADAW test".to_owned(),
            origination_date: "2026-07-22".to_owned(),
            origination_time: "12:00:00".to_owned(),
            time_reference: 42,
        }
    }

    fn decode_peaks(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|value| f32::from_le_bytes(value.try_into().unwrap()))
            .collect()
    }

    #[test]
    fn base_waveform_uses_exact_multichannel_extrema_and_sanitizes_samples() {
        let mut samples = vec![0.0_f32; 65 * 3];
        samples[0..3].copy_from_slice(&[-1.0, 0.25, f32::NAN]);
        samples[63 * 3..63 * 3 + 3].copy_from_slice(&[0.5, f32::INFINITY, -0.75]);
        samples[64 * 3..64 * 3 + 3].copy_from_slice(&[0.125, -0.5, 1.5]);
        assert_eq!(
            base_peak_level(&samples, 3),
            vec![
                -1.0, 0.5, 0.0, 0.25, -0.75, 0.0, 0.125, 0.125, -0.5, -0.5, 1.0, 1.0
            ]
        );
    }

    #[test]
    fn live_waveform_keeps_the_final_partial_bucket_and_preserves_peaks_when_zoomed_out() {
        let mut waveform = LiveWaveform::default();
        waveform.reset(48_000, 2);
        let mut samples = vec![0.0_f32; 65 * 2];
        samples[0..2].copy_from_slice(&[-1.0, 0.5]);
        samples[64 * 2..64 * 2 + 2].copy_from_slice(&[0.25, -0.75]);
        waveform.push(&samples);

        let detailed = waveform.snapshot(0, 65, 10);
        assert_eq!(detailed.frame_count, 65);
        assert_eq!(detailed.end_frame, 65);
        assert_eq!(detailed.frames_per_bucket, 64);
        assert_eq!(detailed.bucket_count, 2);
        assert_eq!(
            decode_peaks(detailed.peaks.as_ref()),
            vec![-1.0, 0.0, 0.0, 0.5, 0.25, 0.25, -0.75, -0.75]
        );

        let overview = waveform.snapshot(0, 65, 1);
        assert_eq!(overview.frames_per_bucket, 256);
        assert_eq!(overview.bucket_count, 1);
        assert_eq!(
            decode_peaks(overview.peaks.as_ref()),
            vec![-1.0, 0.25, -0.75, 0.5]
        );
    }

    #[test]
    fn float_swap_format_is_stereo_32_bit() {
        let format = float_stereo_format(48_000);
        assert_eq!(format.channel_count, 2);
        assert_eq!(format.bits_per_sample, 32);
        assert_eq!(format.block_alignment, 8);
    }

    #[test]
    fn broadcast_metadata_keeps_time_reference_and_asset_id() {
        let metadata = broadcast_metadata(
            "asset-id",
            "YADAW",
            "2026-07-22",
            "12:00:00",
            42,
            String::new(),
        );
        assert_eq!(metadata.originator_reference, "asset-id");
        assert_eq!(metadata.time_reference, 42);
    }

    #[test]
    fn tpdf_dither_is_deterministic_and_never_clips() {
        let mut first = TpdfDither::new(b"fixed-seed");
        let mut second = TpdfDither::new(b"fixed-seed");
        for sample in [-1.0, -0.5, 0.0, 0.5, 1.0] {
            let a = first.apply(sample, 16);
            let b = second.apply(sample, 16);
            assert_eq!(a, b);
            assert!((-1.0..1.0).contains(&a));
        }
    }

    #[test]
    fn recording_ring_drains_all_deterministic_frames_without_hardware() {
        let path = temporary_file("ring-drain");
        let (controller, mut tap) = RecorderController::new(48_000, 2);
        controller.start(start_config(&path)).unwrap();
        for index in 0..4_096 {
            let value = index as f32 / 4_096.0;
            tap.push(&[value, -value]);
        }
        let result = controller.stop().unwrap();
        assert_eq!(result.frame_count, 4_096);
        assert_eq!(result.dropout_frames, 0);
        let mut reader = WaveReader::open(&path).unwrap();
        assert_eq!(reader.frame_length().unwrap(), 4_096);
        assert_eq!(
            reader
                .broadcast_extension()
                .unwrap()
                .unwrap()
                .time_reference,
            42
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn recording_ring_marks_overrun_as_dropout() {
        let path = temporary_file("ring-overrun");
        let (controller, mut tap) = RecorderController::new(1, 2);
        controller.start(start_config(&path)).unwrap();
        for _ in 0..20_000 {
            tap.push(&[0.25, -0.25]);
        }
        let result = controller.stop().unwrap();
        assert!(result.dropout_frames > 0);
        assert_eq!(result.frame_count + result.dropout_frames, 20_000);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn repairs_an_unfinished_data_chunk() {
        let path = temporary_file("repair");
        let writer = WaveWriter::create(&path, float_stereo_format(48_000)).unwrap();
        let mut audio = writer.audio_frame_writer().unwrap();
        audio.write_frames(&vec![0.5_f32; 64]).unwrap();
        drop(audio);

        let frames = repair_recording_header(path.to_string_lossy().into_owned(), 2).unwrap();
        assert_eq!(frames, 32);
        let mut reader = WaveReader::open(&path).unwrap();
        assert_eq!(reader.frame_length().unwrap(), 32);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn fft_resampling_preserves_sine_length_frequency_and_all_final_formats() {
        let source = temporary_file("source-sine");
        let mut writer = WaveWriter::create(&source, float_stereo_format(44_100)).unwrap();
        writer
            .write_broadcast_metadata(&broadcast_metadata(
                "source",
                "YADAW test",
                "2026-07-22",
                "12:00:00",
                0,
                String::new(),
            ))
            .unwrap();
        let mut audio = writer.audio_frame_writer().unwrap();
        let input_frames = 4_410;
        let mut sine = Vec::with_capacity(input_frames * 2);
        for frame in 0..input_frames {
            let sample = (TAU * 1_000.0 * frame as f32 / 44_100.0).sin() * 0.5;
            sine.extend_from_slice(&[sample, sample]);
        }
        audio.write_frames(&sine).unwrap();
        audio.end().unwrap();

        for bit_depth in ["float32", "pcm24", "pcm16"] {
            let output = temporary_file(bit_depth);
            let finalized = finalize(&NativeFinalizeRecordingConfig {
                input_path: source.to_string_lossy().into_owned(),
                output_path: output.to_string_lossy().into_owned(),
                target_sample_rate: 48_000,
                bit_depth: bit_depth.to_owned(),
                asset_id: format!("asset-{bit_depth}"),
                originator: "YADAW test".to_owned(),
                origination_date: "2026-07-22".to_owned(),
                origination_time: "12:00:00".to_owned(),
                time_reference: 123,
                channel_indices: None,
            })
            .unwrap();
            assert!((finalized.frame_count - 4_800).abs() <= 1);
            assert_eq!(finalized.bit_depth, bit_depth);
            let mut reader = WaveReader::open(&output).unwrap();
            assert_eq!(
                reader.format().unwrap().bits_per_sample,
                match bit_depth {
                    "pcm24" => 24,
                    "pcm16" => 16,
                    _ => 32,
                }
            );
            assert_eq!(
                reader
                    .broadcast_extension()
                    .unwrap()
                    .unwrap()
                    .time_reference,
                123
            );
            if bit_depth == "float32" {
                let frame_count = reader.frame_length().unwrap() as usize;
                let mut rendered = vec![0.0_f32; frame_count * 2];
                reader
                    .audio_frame_reader()
                    .unwrap()
                    .read_frames(&mut rendered)
                    .unwrap();
                let left: Vec<f32> = rendered.chunks_exact(2).map(|frame| frame[0]).collect();
                let mut below = false;
                let mut positive_crossings = 0;
                for sample in &left {
                    if *sample < -0.1 {
                        below = true;
                    } else if below && *sample > 0.1 {
                        positive_crossings += 1;
                        below = false;
                    }
                }
                assert!(
                    (95..=105).contains(&positive_crossings),
                    "unexpected positive crossing count: {positive_crossings}"
                );
                let peak = left
                    .iter()
                    .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
                assert!((peak - 0.5).abs() < 0.01);
            }
            assert_eq!(finalized.content_hash.len(), 64);
            let analyzed = analyze_waveform_path(output.to_str().unwrap()).unwrap();
            assert_eq!(
                finalized.waveform_levels.len(),
                analyzed.waveform_levels.len()
            );
            for (cached, actual) in finalized
                .waveform_levels
                .iter()
                .zip(analyzed.waveform_levels.iter())
            {
                assert_eq!(cached.frames_per_bucket, actual.frames_per_bucket);
                assert_eq!(cached.bucket_count, actual.bucket_count);
                assert_eq!(cached.peaks.as_ref(), actual.peaks.as_ref());
            }
            fs::remove_file(output).unwrap();
        }
        fs::remove_file(source).unwrap();
    }
}
