use super::*;
use super::{
    waveform_analysis::analyze_waveform_path,
    writer_format::{broadcast_metadata, pcm_stereo_format, recording_error},
};

pub(super) struct TpdfDither {
    state: u64,
}

impl TpdfDither {
    pub(super) fn new(seed: &[u8]) -> Self {
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

    pub(super) fn apply(&mut self, sample: f32, bits: u32) -> f32 {
        let lsb = 1.0 / (1_u32 << (bits - 1)) as f32;
        (sample + (self.uniform() - self.uniform()) * lsb).clamp(-1.0, 1.0 - lsb)
    }
}

pub(super) fn finalize(config: &NativeFinalizeRecordingConfig) -> Result<NativeFinalizedRecording> {
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
