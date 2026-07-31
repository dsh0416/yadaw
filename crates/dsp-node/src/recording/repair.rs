use super::writer_format::{broadcast_metadata, float_stereo_format, recording_error};
use super::*;

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

    use crate::recording::{
        InputFrame, MAX_INPUT_CHANNELS, NativeFinalizeRecordingConfig, NativeRecordingStartConfig,
        RecorderController, RecordingTap, finalize::finalize, waveform::LiveWaveform,
        writer_format::float_format,
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
