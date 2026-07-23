use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use bwavfile::{AudioFrameWriter, Bext, WAVE_TAG_FLOAT, WaveFmt, WaveReader, WaveWriter};
use napi::{Error, Result, Status, Task};
use napi_derive::napi;
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};
use rubato::{Fft, FixedSync, Resampler, audioadapter_buffers::direct::InterleavedSlice};
use sha2::{Digest, Sha256};

pub type StereoFrame = [f32; 2];

const RECORDING_RING_SECONDS: usize = 8;
const WRITER_BLOCK_FRAMES: usize = 2_048;

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
}

fn recording_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn float_stereo_format(sample_rate: u32) -> WaveFmt {
    WaveFmt {
        tag: WAVE_TAG_FLOAT,
        channel_count: 2,
        sample_rate,
        bytes_per_second: sample_rate * 8,
        block_alignment: 8,
        bits_per_sample: 32,
        extended_format: None,
    }
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

pub struct RecordingTap {
    producer: HeapProd<StereoFrame>,
    active: Arc<AtomicBool>,
    dropout_frames: Arc<AtomicU64>,
}

impl RecordingTap {
    pub fn push(&mut self, frame: StereoFrame) {
        if self.active.load(Ordering::Relaxed) && self.producer.try_push(frame).is_err() {
            self.dropout_frames.fetch_add(1, Ordering::Relaxed);
        }
    }
}

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

struct ActiveWriter {
    path: String,
    frames: u64,
    writer: AudioFrameWriter<BufWriter<File>>,
}

fn write_available(
    consumer: &mut HeapCons<StereoFrame>,
    active: &mut ActiveWriter,
    scratch: &mut Vec<f32>,
) -> std::result::Result<(), String> {
    scratch.clear();
    while scratch.len() < WRITER_BLOCK_FRAMES * 2 {
        let Some(frame) = consumer.try_pop() else {
            break;
        };
        scratch.extend_from_slice(&frame);
    }
    if scratch.is_empty() {
        return Ok(());
    }
    active
        .writer
        .write_frames(scratch)
        .map_err(|error| error.to_string())?;
    active.frames += (scratch.len() / 2) as u64;
    Ok(())
}

fn writer_thread(
    mut consumer: HeapCons<StereoFrame>,
    receiver: Receiver<WriterCommand>,
    active_flag: Arc<AtomicBool>,
    dropout_frames: Arc<AtomicU64>,
    sample_rate: u32,
) {
    let mut current: Option<ActiveWriter> = None;
    let mut scratch = Vec::with_capacity(WRITER_BLOCK_FRAMES * 2);
    loop {
        if let Some(active) = current.as_mut()
            && write_available(&mut consumer, active, &mut scratch).is_err()
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
                    let mut writer =
                        WaveWriter::create(&config.path, float_stereo_format(sample_rate))
                            .map_err(|error| error.to_string())?;
                    writer
                        .write_broadcast_metadata(&broadcast_metadata(
                            &config.asset_id,
                            &config.originator,
                            &config.origination_date,
                            &config.origination_time,
                            config.time_reference.max(0) as u64,
                            format!("A=PCM,F={sample_rate},W=32,M=stereo,T=YADAW swap\r\n"),
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
                        write_available(&mut consumer, &mut writer, &mut scratch)?;
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
                        channels: 2,
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
                        let _ = write_available(&mut consumer, &mut writer, &mut scratch);
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
}

impl RecorderController {
    pub fn new(sample_rate: u32) -> (Self, RecordingTap) {
        let capacity = sample_rate as usize * RECORDING_RING_SECONDS;
        let ring = HeapRb::<StereoFrame>::new(capacity.max(8_192));
        let (producer, consumer) = ring.split();
        let active = Arc::new(AtomicBool::new(false));
        let dropout_frames = Arc::new(AtomicU64::new(0));
        let (sender, receiver) = mpsc::channel();
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
                );
            })
            .expect("recording writer thread must start");
        (
            Self {
                sender,
                active: Arc::clone(&active),
                thread: Some(thread),
            },
            RecordingTap {
                producer,
                active,
                dropout_frames,
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
    let channels = source_format.channel_count as usize;
    if channels == 0 {
        return Err(Error::new(Status::InvalidArg, "recording has no channels"));
    }
    let mut samples = vec![0.0_f32; source_frames * channels];
    let mut frame_reader = reader
        .audio_frame_reader()
        .map_err(|error| recording_error("failed to open swap audio", error))?;
    let read_frames = frame_reader
        .read_frames(&mut samples)
        .map_err(|error| recording_error("failed to read swap audio", error))?
        as usize;
    samples.truncate(read_frames * channels);

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
    let mut audio = writer
        .audio_frame_writer()
        .map_err(|error| recording_error("failed to start final BWF audio", error))?;
    if config.bit_depth == "float32" {
        audio
            .write_frames(&processed)
            .map_err(|error| recording_error("failed to write float recording", error))?;
    } else {
        let mut dither = TpdfDither::new(config.asset_id.as_bytes());
        let dithered: Vec<f32> = processed
            .iter()
            .map(|sample| dither.apply(*sample, bits as u32))
            .collect();
        audio
            .write_frames(&dithered)
            .map_err(|error| recording_error("failed to write integer recording", error))?;
    }
    audio
        .end()
        .map_err(|error| recording_error("failed to finalize BWF", error))?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&config.output_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| recording_error("failed to flush final BWF", error))?;

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
        frame_count: (processed.len() / channels).min(i64::MAX as usize) as i64,
        time_reference: config.time_reference.max(0),
    })
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
        NativeFinalizeRecordingConfig, NativeRecordingStartConfig, RecorderController, TpdfDither,
        broadcast_metadata, finalize, float_stereo_format, repair_recording_header,
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
        let (controller, mut tap) = RecorderController::new(48_000);
        controller.start(start_config(&path)).unwrap();
        for index in 0..4_096 {
            let value = index as f32 / 4_096.0;
            tap.push([value, -value]);
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
        let (controller, mut tap) = RecorderController::new(1);
        controller.start(start_config(&path)).unwrap();
        for _ in 0..20_000 {
            tap.push([0.25, -0.25]);
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
            fs::remove_file(output).unwrap();
        }
        fs::remove_file(source).unwrap();
    }
}
