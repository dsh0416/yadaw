use super::{
    AudioEngine, EngineCommand, MAX_OUTPUT_CHANNELS, MAX_PLUGIN_BLOCK_FRAMES, NativeLatencyPolicy,
    NativeMixerGraph, TransportAction, compile_graph_build,
};
use crate::{EngineError, EngineResult};
use bwavfile::{WAVE_TAG_FLOAT, WaveFmt, WaveWriter};
use ebur128::{EbuR128, Mode as EbuMode};
use flac_bound::{FlacEncoder, WriteWrapper};
use mp3lame_encoder::{
    Bitrate, Builder as Mp3Builder, FlushGap, InterleavedPcm, Mode as Mp3Mode, MonoPcm, Quality,
    VbrMode,
};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

const TAIL_SILENCE_AMPLITUDE: f32 = 0.000_031_622_777;
const MONO_FOLD_GAIN: f32 = 0.501_187_2;
const MAX_TAIL_SECONDS: u64 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeBounceChannelMode {
    Stereo,
    Mono,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeBounceDither {
    Off,
    Tpdf,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NativeBounceNormalization {
    Off,
    OverloadProtection,
    TruePeak { target_dbtp: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeBounceFormat {
    WavPcm {
        bits: u16,
        dither: NativeBounceDither,
    },
    WavFloat,
    Flac {
        bits: u16,
        compression: u32,
        dither: NativeBounceDither,
    },
    Mp3Cbr {
        kbps: u16,
    },
    Mp3Vbr {
        quality: u8,
    },
}

pub struct NativeBounceRequest {
    pub graph: NativeMixerGraph,
    pub output_channel_id: String,
    pub start_frame: u64,
    pub end_frame: u64,
    pub target_sample_rate: u32,
    pub channel_mode: NativeBounceChannelMode,
    pub include_tail: bool,
    pub format: NativeBounceFormat,
    pub normalization: NativeBounceNormalization,
    pub scratch_path: PathBuf,
    pub encoded_path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeBounceProgress {
    Preparing,
    Rendering {
        completed_frames: u64,
        total_frames: u64,
    },
    Analyzing,
    Encoding {
        completed_frames: u64,
        total_frames: u64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeBounceResult {
    pub rendered_frames: u64,
    pub sample_peak: f64,
    pub true_peak: f64,
    pub normalization_gain: f64,
    pub tail_truncated: bool,
}

fn bounce_error(context: &str, error: impl std::fmt::Display) -> EngineError {
    EngineError::State(format!("{context}: {error}"))
}

fn prepare_graph(
    mut graph: NativeMixerGraph,
    output_channel_id: &str,
) -> EngineResult<NativeMixerGraph> {
    let mut found = false;
    graph.latency_policy = NativeLatencyPolicy::Normal;
    for channel in &mut graph.channels {
        channel.record_armed = false;
        channel.input_monitoring = false;
        if channel.system_role.is_some() {
            channel.muted = true;
        }
        if channel.kind == "output" && channel.id == output_channel_id {
            channel.hardware_output_channels = vec![1, 2];
            found = true;
        } else {
            channel.hardware_output_channels.clear();
        }
    }
    if !found {
        return Err(EngineError::InvalidConfiguration(
            "bounce target is not an Output channel".to_owned(),
        ));
    }
    Ok(graph)
}

struct LinearResampler {
    source_rate: f64,
    target_rate: f64,
    source_index: u64,
    output_frames: u64,
    next_output_position: f64,
    previous: Option<[f32; 2]>,
}

impl LinearResampler {
    fn new(source_rate: u32, target_rate: u32) -> Self {
        Self {
            source_rate: f64::from(source_rate),
            target_rate: f64::from(target_rate),
            source_index: 0,
            output_frames: 0,
            next_output_position: 0.0,
            previous: None,
        }
    }

    fn push(&mut self, input: &[[f32; 2]], output: &mut Vec<[f32; 2]>) {
        let step = self.source_rate / self.target_rate;
        for &current in input {
            let index = self.source_index as f64;
            let previous = self.previous.unwrap_or(current);
            while self.next_output_position <= index {
                let fraction = if self.source_index == 0 {
                    0.0
                } else {
                    (self.next_output_position - (index - 1.0)).clamp(0.0, 1.0) as f32
                };
                output.push([
                    previous[0] + (current[0] - previous[0]) * fraction,
                    previous[1] + (current[1] - previous[1]) * fraction,
                ]);
                self.output_frames = self.output_frames.saturating_add(1);
                self.next_output_position += step;
            }
            self.previous = Some(current);
            self.source_index = self.source_index.saturating_add(1);
        }
    }

    fn finish(&mut self, output: &mut Vec<[f32; 2]>) {
        let target_frames =
            (self.source_index as f64 * self.target_rate / self.source_rate).round() as u64;
        let last = self.previous.unwrap_or([0.0, 0.0]);
        while self.output_frames < target_frames {
            output.push(last);
            self.output_frames = self.output_frames.saturating_add(1);
        }
    }
}

fn write_scratch_frames(
    writer: &mut BufWriter<File>,
    frames: &[[f32; 2]],
    mode: NativeBounceChannelMode,
) -> EngineResult<()> {
    for frame in frames {
        if mode == NativeBounceChannelMode::Mono {
            let mono = (frame[0] + frame[1]) * MONO_FOLD_GAIN;
            writer
                .write_all(&mono.to_le_bytes())
                .map_err(|error| bounce_error("write bounce scratch", error))?;
        } else {
            writer
                .write_all(&frame[0].to_le_bytes())
                .map_err(|error| bounce_error("write bounce scratch", error))?;
            writer
                .write_all(&frame[1].to_le_bytes())
                .map_err(|error| bounce_error("write bounce scratch", error))?;
        }
    }
    Ok(())
}

fn read_scratch_block(
    reader: &mut BufReader<File>,
    channels: usize,
    buffer: &mut Vec<f32>,
) -> EngineResult<usize> {
    let mut bytes = vec![0_u8; MAX_PLUGIN_BLOCK_FRAMES * channels * 4];
    let mut read = 0;
    while read < bytes.len() {
        let count = reader
            .read(&mut bytes[read..])
            .map_err(|error| bounce_error("read bounce scratch", error))?;
        if count == 0 {
            break;
        }
        read += count;
    }
    if read % (channels * 4) != 0 {
        return Err(EngineError::State(
            "bounce scratch contains a partial frame".to_owned(),
        ));
    }
    buffer.clear();
    buffer.extend(
        bytes[..read]
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])),
    );
    Ok(read / (channels * 4))
}

fn analyze(request: &NativeBounceRequest, channels: usize) -> EngineResult<(u64, f64, f64)> {
    let file = File::open(&request.scratch_path)
        .map_err(|error| bounce_error("open bounce scratch", error))?;
    let mut reader = BufReader::new(file);
    let mut meter = EbuR128::new(
        channels as u32,
        request.target_sample_rate,
        EbuMode::M | EbuMode::TRUE_PEAK,
    )
    .map_err(|error| bounce_error("create true-peak analyzer", error))?;
    let mut block = Vec::with_capacity(MAX_PLUGIN_BLOCK_FRAMES * channels);
    let mut frames = 0_u64;
    let mut sample_peak = 0.0_f64;
    loop {
        let count = read_scratch_block(&mut reader, channels, &mut block)?;
        if count == 0 {
            break;
        }
        for &sample in &block {
            sample_peak = sample_peak.max(f64::from(sample.abs()));
        }
        meter
            .add_frames_f32(&block)
            .map_err(|error| bounce_error("measure true peak", error))?;
        frames = frames.saturating_add(count as u64);
    }
    let mut true_peak = 0.0_f64;
    for channel in 0..channels {
        true_peak = true_peak.max(
            meter
                .true_peak(channel as u32)
                .map_err(|error| bounce_error("read true peak", error))?,
        );
    }
    Ok((frames, sample_peak, true_peak))
}

fn normalization_gain(mode: NativeBounceNormalization, sample_peak: f64, true_peak: f64) -> f64 {
    match mode {
        NativeBounceNormalization::Off => 1.0,
        NativeBounceNormalization::OverloadProtection => {
            if sample_peak > 1.0 {
                1.0 / sample_peak
            } else {
                1.0
            }
        }
        NativeBounceNormalization::TruePeak { target_dbtp } => {
            if true_peak <= f64::EPSILON {
                1.0
            } else {
                10_f64.powf(target_dbtp / 20.0) / true_peak
            }
        }
    }
}

struct Dither {
    state: u64,
}
impl Dither {
    fn next(&mut self) -> f32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        (self.state as u32) as f32 / u32::MAX as f32
    }
    fn apply(&mut self, sample: f32, bits: u16, enabled: NativeBounceDither) -> f32 {
        if enabled == NativeBounceDither::Off {
            return sample;
        }
        let lsb = 1.0 / ((1_u64 << (bits - 1)) - 1) as f32;
        sample + (self.next() - self.next()) * lsb
    }
}

fn wave_format(rate: u32, channels: usize, format: NativeBounceFormat) -> WaveFmt {
    match format {
        NativeBounceFormat::WavFloat => WaveFmt {
            tag: WAVE_TAG_FLOAT,
            channel_count: channels as u16,
            sample_rate: rate,
            bytes_per_second: rate * channels as u32 * 4,
            block_alignment: channels as u16 * 4,
            bits_per_sample: 32,
            extended_format: None,
        },
        NativeBounceFormat::WavPcm { bits, .. } => {
            if channels == 1 {
                WaveFmt::new_pcm_mono(rate, bits)
            } else {
                WaveFmt::new_pcm_stereo(rate, bits)
            }
        }
        _ => unreachable!(),
    }
}

fn encode_wav(
    request: &NativeBounceRequest,
    channels: usize,
    gain: f64,
    frames: u64,
    progress: &mut impl FnMut(NativeBounceProgress),
    cancel: &AtomicBool,
) -> EngineResult<()> {
    let writer = WaveWriter::create(
        &request.encoded_path,
        wave_format(request.target_sample_rate, channels, request.format),
    )
    .map_err(|error| bounce_error("create WAV", error))?;
    let mut output = writer
        .audio_frame_writer()
        .map_err(|error| bounce_error("start WAV data", error))?;
    let mut reader = BufReader::new(
        File::open(&request.scratch_path)
            .map_err(|error| bounce_error("open bounce scratch", error))?,
    );
    let mut block = Vec::new();
    let mut done = 0_u64;
    let mut dither = Dither {
        state: 0x9e37_79b9_7f4a_7c15,
    };
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(EngineError::State("bounce cancelled".to_owned()));
        }
        let count = read_scratch_block(&mut reader, channels, &mut block)?;
        if count == 0 {
            break;
        }
        let (bits, enabled) = match request.format {
            NativeBounceFormat::WavPcm { bits, dither } => (bits, dither),
            NativeBounceFormat::WavFloat => (32, NativeBounceDither::Off),
            _ => unreachable!(),
        };
        for sample in &mut block {
            *sample = dither
                .apply((*sample as f64 * gain) as f32, bits, enabled)
                .clamp(-1.0, 1.0);
        }
        output
            .write_frames(&block)
            .map_err(|error| bounce_error("write WAV", error))?;
        done += count as u64;
        progress(NativeBounceProgress::Encoding {
            completed_frames: done,
            total_frames: frames,
        });
    }
    output
        .end()
        .map_err(|error| bounce_error("finalize WAV", error))?;
    Ok(())
}

fn encode_flac(
    request: &NativeBounceRequest,
    channels: usize,
    gain: f64,
    frames: u64,
    progress: &mut impl FnMut(NativeBounceProgress),
    cancel: &AtomicBool,
) -> EngineResult<()> {
    let NativeBounceFormat::Flac {
        bits,
        compression,
        dither,
    } = request.format
    else {
        unreachable!()
    };
    let mut file = BufWriter::new(
        File::create(&request.encoded_path).map_err(|error| bounce_error("create FLAC", error))?,
    );
    let mut wrapper = WriteWrapper(&mut file);
    let config = FlacEncoder::new()
        .ok_or_else(|| EngineError::State("could not allocate FLAC encoder".to_owned()))?
        .channels(channels as u32)
        .bits_per_sample(u32::from(bits))
        .sample_rate(request.target_sample_rate)
        .compression_level(compression)
        .total_samples_estimate(frames);
    let mut encoder = config
        .init_write(&mut wrapper)
        .map_err(|error| bounce_error("initialize FLAC", format!("{error:?}")))?;
    let mut reader = BufReader::new(
        File::open(&request.scratch_path)
            .map_err(|error| bounce_error("open bounce scratch", error))?,
    );
    let mut block = Vec::new();
    let mut quantized = Vec::new();
    let mut done = 0_u64;
    let mut noise = Dither {
        state: 0xd1b5_4a32_d192_ed03,
    };
    let scale = ((1_i64 << (bits - 1)) - 1) as f32;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(EngineError::State("bounce cancelled".to_owned()));
        }
        let count = read_scratch_block(&mut reader, channels, &mut block)?;
        if count == 0 {
            break;
        }
        quantized.clear();
        quantized.extend(block.iter().map(|sample| {
            (noise
                .apply((*sample as f64 * gain) as f32, bits, dither)
                .clamp(-1.0, 1.0)
                * scale)
                .round() as i32
        }));
        encoder
            .process_interleaved(&quantized, count as u32)
            .map_err(|()| EngineError::State("FLAC encoder rejected audio".to_owned()))?;
        done += count as u64;
        progress(NativeBounceProgress::Encoding {
            completed_frames: done,
            total_frames: frames,
        });
    }
    encoder
        .finish()
        .map_err(|encoder| bounce_error("finalize FLAC", format!("{:?}", encoder.state())))?;
    Ok(())
}

fn quality(value: u8) -> Quality {
    match value {
        0 => Quality::Best,
        1 => Quality::SecondBest,
        2 => Quality::NearBest,
        3 => Quality::VeryNice,
        4 => Quality::Nice,
        5 => Quality::Good,
        6 => Quality::Decent,
        7 => Quality::Ok,
        8 => Quality::SecondWorst,
        _ => Quality::Worst,
    }
}
fn bitrate(value: u16) -> Bitrate {
    match value {
        128 => Bitrate::Kbps128,
        192 => Bitrate::Kbps192,
        256 => Bitrate::Kbps256,
        _ => Bitrate::Kbps320,
    }
}

fn tail_render_limits(
    include_tail: bool,
    tail_end_frame: Option<u64>,
    content_end_frame: u64,
    source_rate: u32,
) -> (Option<u64>, u64) {
    if !include_tail {
        return (Some(0), 0);
    }
    let known_tail = tail_end_frame.map(|end| end.saturating_sub(content_end_frame));
    (known_tail, u64::from(source_rate) * MAX_TAIL_SECONDS)
}

fn encode_mp3(
    request: &NativeBounceRequest,
    channels: usize,
    gain: f64,
    frames: u64,
    progress: &mut impl FnMut(NativeBounceProgress),
    cancel: &AtomicBool,
) -> EngineResult<()> {
    let mut builder = Mp3Builder::new()
        .ok_or_else(|| EngineError::State("could not allocate MP3 encoder".to_owned()))?
        .with_num_channels(channels as u8)
        .map_err(|error| bounce_error("configure MP3 channels", error))?
        .with_sample_rate(request.target_sample_rate)
        .map_err(|error| bounce_error("configure MP3 rate", error))?
        .with_mode(if channels == 1 {
            Mp3Mode::Mono
        } else {
            Mp3Mode::JointStereo
        })
        .map_err(|error| bounce_error("configure MP3 mode", error))?
        .with_to_write_vbr_tag(false)
        .map_err(|error| bounce_error("configure MP3 tag", error))?;
    builder = match request.format {
        NativeBounceFormat::Mp3Cbr { kbps } => builder
            .with_vbr_mode(VbrMode::Off)
            .and_then(|value| value.with_brate(bitrate(kbps)))
            .map_err(|error| bounce_error("configure MP3 CBR", error))?,
        NativeBounceFormat::Mp3Vbr { quality: value } => builder
            .with_vbr_mode(VbrMode::Mtrh)
            .and_then(|builder| builder.with_vbr_quality(quality(value)))
            .map_err(|error| bounce_error("configure MP3 VBR", error))?,
        _ => unreachable!(),
    };
    let mut encoder = builder
        .build()
        .map_err(|error| bounce_error("initialize MP3", error))?;
    let mut file = BufWriter::new(
        File::create(&request.encoded_path).map_err(|error| bounce_error("create MP3", error))?,
    );
    let mut reader = BufReader::new(
        File::open(&request.scratch_path)
            .map_err(|error| bounce_error("open bounce scratch", error))?,
    );
    let mut block = Vec::new();
    let mut encoded = Vec::new();
    let mut done = 0_u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(EngineError::State("bounce cancelled".to_owned()));
        }
        let count = read_scratch_block(&mut reader, channels, &mut block)?;
        if count == 0 {
            break;
        }
        for sample in &mut block {
            *sample = (*sample as f64 * gain) as f32;
        }
        encoded.clear();
        encoded.reserve(mp3lame_encoder::max_required_buffer_size(count));
        if channels == 1 {
            encoder.encode_to_vec(MonoPcm(&block), &mut encoded)
        } else {
            encoder.encode_to_vec(InterleavedPcm(&block), &mut encoded)
        }
        .map_err(|error| bounce_error("encode MP3", error))?;
        file.write_all(&encoded)
            .map_err(|error| bounce_error("write MP3", error))?;
        done += count as u64;
        progress(NativeBounceProgress::Encoding {
            completed_frames: done,
            total_frames: frames,
        });
    }
    encoded.clear();
    encoded.reserve(7200);
    encoder
        .flush_to_vec::<FlushGap>(&mut encoded)
        .map_err(|error| bounce_error("finalize MP3", error))?;
    file.write_all(&encoded)
        .map_err(|error| bounce_error("write MP3 tail", error))?;
    Ok(())
}

pub fn render_bounce_output(
    mut request: NativeBounceRequest,
    cancel: &AtomicBool,
    mut progress: impl FnMut(NativeBounceProgress),
) -> EngineResult<NativeBounceResult> {
    if request.start_frame >= request.end_frame || request.target_sample_rate == 0 {
        return Err(EngineError::InvalidConfiguration(
            "invalid bounce range or sample rate".to_owned(),
        ));
    }
    progress(NativeBounceProgress::Preparing);
    let source_rate = request.graph.sample_rate;
    request.graph = prepare_graph(request.graph, &request.output_channel_id)?;
    let engine = AudioEngine::new();
    let built = compile_graph_build(engine.begin_graph_build(request.graph.clone())?)?;
    let mut runtime = built.runtime;
    let (known_tail, maximum_tail) = tail_render_limits(
        request.include_tail,
        runtime.tail_end_frame,
        runtime.content_end_frame,
        source_rate,
    );
    runtime.project_end_frame = request
        .end_frame
        .saturating_add(known_tail.unwrap_or(maximum_tail));
    runtime.handle_command(EngineCommand::Transport(
        TransportAction::Seek,
        request.start_frame,
    ));
    runtime.handle_command(EngineCommand::Transport(
        TransportAction::Play,
        request.start_frame,
    ));
    let mut scratch = BufWriter::new(
        File::create(&request.scratch_path)
            .map_err(|error| bounce_error("create bounce scratch", error))?,
    );
    let mut resampler = LinearResampler::new(source_rate, request.target_sample_rate);
    let inputs = vec![[0.0_f32; MAX_OUTPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES];
    let mut outputs = vec![[0.0_f32; MAX_OUTPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES];
    let mut stereo = Vec::with_capacity(MAX_PLUGIN_BLOCK_FRAMES);
    let mut resampled = Vec::with_capacity(MAX_PLUGIN_BLOCK_FRAMES * 2);
    let range_frames = request.end_frame - request.start_frame;
    let mut rendered_source = 0_u64;
    while rendered_source < range_frames {
        if cancel.load(Ordering::Relaxed) {
            return Err(EngineError::State("bounce cancelled".to_owned()));
        }
        let count =
            usize::try_from((range_frames - rendered_source).min(MAX_PLUGIN_BLOCK_FRAMES as u64))
                .unwrap_or(MAX_PLUGIN_BLOCK_FRAMES);
        runtime.render_block(&inputs[..count], &mut outputs[..count], None, None);
        stereo.clear();
        stereo.extend(outputs[..count].iter().map(|frame| [frame[0], frame[1]]));
        resampled.clear();
        resampler.push(&stereo, &mut resampled);
        write_scratch_frames(&mut scratch, &resampled, request.channel_mode)?;
        rendered_source += count as u64;
        progress(NativeBounceProgress::Rendering {
            completed_frames: rendered_source,
            total_frames: range_frames.saturating_add(known_tail.unwrap_or(maximum_tail)),
        });
    }
    runtime.clips.clear();
    runtime.midi_events.clear();
    runtime.handle_command(EngineCommand::Transport(
        TransportAction::Pause,
        request.end_frame,
    ));
    runtime.handle_command(EngineCommand::Transport(
        TransportAction::Play,
        request.end_frame,
    ));
    let mut tail_rendered = 0_u64;
    let mut quiet_frames = 0_u64;
    let tail_limit = known_tail.unwrap_or(maximum_tail).min(maximum_tail);
    while tail_rendered < tail_limit {
        if cancel.load(Ordering::Relaxed) {
            return Err(EngineError::State("bounce cancelled".to_owned()));
        }
        let count =
            usize::try_from((tail_limit - tail_rendered).min(MAX_PLUGIN_BLOCK_FRAMES as u64))
                .unwrap_or(MAX_PLUGIN_BLOCK_FRAMES);
        runtime.render_block(&inputs[..count], &mut outputs[..count], None, None);
        let peak = outputs[..count].iter().fold(0.0_f32, |peak, frame| {
            peak.max(frame[0].abs()).max(frame[1].abs())
        });
        if peak < TAIL_SILENCE_AMPLITUDE {
            quiet_frames += count as u64;
        } else {
            quiet_frames = 0;
        }
        stereo.clear();
        stereo.extend(outputs[..count].iter().map(|frame| [frame[0], frame[1]]));
        resampled.clear();
        resampler.push(&stereo, &mut resampled);
        write_scratch_frames(&mut scratch, &resampled, request.channel_mode)?;
        tail_rendered += count as u64;
        progress(NativeBounceProgress::Rendering {
            completed_frames: range_frames + tail_rendered,
            total_frames: range_frames + tail_limit,
        });
        if known_tail.is_none() && quiet_frames >= u64::from(source_rate) * 2 {
            break;
        }
    }
    resampled.clear();
    resampler.finish(&mut resampled);
    write_scratch_frames(&mut scratch, &resampled, request.channel_mode)?;
    scratch
        .flush()
        .map_err(|error| bounce_error("flush bounce scratch", error))?;
    progress(NativeBounceProgress::Analyzing);
    let channels = if request.channel_mode == NativeBounceChannelMode::Mono {
        1
    } else {
        2
    };
    let (frames, sample_peak, true_peak) = analyze(&request, channels)?;
    let gain = normalization_gain(request.normalization, sample_peak, true_peak);
    progress(NativeBounceProgress::Encoding {
        completed_frames: 0,
        total_frames: frames,
    });
    match request.format {
        NativeBounceFormat::WavPcm { .. } | NativeBounceFormat::WavFloat => {
            encode_wav(&request, channels, gain, frames, &mut progress, cancel)?
        }
        NativeBounceFormat::Flac { .. } => {
            encode_flac(&request, channels, gain, frames, &mut progress, cancel)?
        }
        NativeBounceFormat::Mp3Cbr { .. } | NativeBounceFormat::Mp3Vbr { .. } => {
            encode_mp3(&request, channels, gain, frames, &mut progress, cancel)?
        }
    }
    Ok(NativeBounceResult {
        rendered_frames: frames,
        sample_peak,
        true_peak,
        normalization_gain: gain,
        tail_truncated: known_tail.is_none() && tail_rendered >= maximum_tail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_graph() -> NativeMixerGraph {
        NativeMixerGraph {
            generation: 0,
            sample_rate: 48_000,
            project_end_tick: 0,
            latency_policy: NativeLatencyPolicy::Normal,
            channels: Vec::new(),
            sends: Vec::new(),
            clips: Vec::new(),
            plugins: Vec::new(),
            midi_clips: Vec::new(),
            tempo_events: Vec::new(),
            time_signature_events: Vec::new(),
        }
    }

    fn encoder_request(
        scratch_path: PathBuf,
        encoded_path: PathBuf,
        format: NativeBounceFormat,
    ) -> NativeBounceRequest {
        NativeBounceRequest {
            graph: empty_graph(),
            output_channel_id: "output".to_owned(),
            start_frame: 0,
            end_frame: 4_608,
            target_sample_rate: 48_000,
            channel_mode: NativeBounceChannelMode::Mono,
            include_tail: true,
            format,
            normalization: NativeBounceNormalization::Off,
            scratch_path,
            encoded_path,
        }
    }

    #[test]
    fn overload_protection_never_raises_level() {
        assert_eq!(
            normalization_gain(NativeBounceNormalization::OverloadProtection, 0.5, 0.5),
            1.0
        );
        assert!(
            (normalization_gain(NativeBounceNormalization::OverloadProtection, 2.0, 2.0) - 0.5)
                .abs()
                < f64::EPSILON
        );
    }

    #[test]
    fn true_peak_normalization_targets_requested_level_and_preserves_silence() {
        assert_eq!(
            normalization_gain(
                NativeBounceNormalization::TruePeak { target_dbtp: -1.0 },
                0.0,
                0.0
            ),
            1.0
        );
        let gain = normalization_gain(
            NativeBounceNormalization::TruePeak { target_dbtp: -1.0 },
            0.5,
            0.5,
        );
        assert!((0.5 * gain - 10_f64.powf(-1.0 / 20.0)).abs() < 1.0e-12);
    }

    #[test]
    fn linear_resampler_keeps_state_across_bounded_blocks() {
        let mut resampler = LinearResampler::new(48_000, 96_000);
        let mut first = Vec::new();
        let mut second = Vec::new();
        resampler.push(&[[0.0, 0.0], [1.0, -1.0]], &mut first);
        resampler.push(&[[0.0, 0.0]], &mut second);
        let mut tail = Vec::new();
        resampler.finish(&mut tail);
        let joined = first
            .into_iter()
            .chain(second)
            .chain(tail)
            .collect::<Vec<_>>();
        assert_eq!(joined.len(), 6);
        assert_eq!(joined[1], [0.5, -0.5]);
        assert_eq!(joined[3], [0.5, -0.5]);
    }

    #[test]
    fn mono_fold_uses_minus_six_db_per_channel() {
        let mono = (1.0_f32 + 1.0) * MONO_FOLD_GAIN;
        assert!(mono <= 1.003);
        assert!(mono >= 1.002);
    }

    #[test]
    fn disabled_tail_processing_stops_at_the_requested_end_frame() {
        assert_eq!(
            tail_render_limits(false, None, 48_000, 48_000),
            (Some(0), 0)
        );
        assert_eq!(
            tail_render_limits(false, Some(72_000), 48_000, 48_000),
            (Some(0), 0)
        );
    }

    #[test]
    fn encoders_write_expected_container_signatures() {
        let unique = format!(
            "heron-bounce-encoder-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        );
        let directory = std::env::temp_dir();
        let scratch_path = directory.join(format!("{unique}.scratch"));
        let scratch = (0..4_608)
            .flat_map(|frame| {
                let sample =
                    ((frame as f32 / 48_000.0) * 440.0 * std::f32::consts::TAU).sin() * 0.25;
                sample.to_le_bytes()
            })
            .collect::<Vec<_>>();
        std::fs::write(&scratch_path, scratch).expect("write encoder test scratch");
        let cancel = AtomicBool::new(false);
        let formats = [
            (
                "wav",
                NativeBounceFormat::WavPcm {
                    bits: 24,
                    dither: NativeBounceDither::Tpdf,
                },
            ),
            (
                "flac",
                NativeBounceFormat::Flac {
                    bits: 24,
                    compression: 5,
                    dither: NativeBounceDither::Tpdf,
                },
            ),
            ("mp3", NativeBounceFormat::Mp3Cbr { kbps: 192 }),
        ];
        for (extension, format) in formats {
            let encoded_path = directory.join(format!("{unique}.{extension}"));
            let request = encoder_request(scratch_path.clone(), encoded_path.clone(), format);
            let mut progress = |_| {};
            match format {
                NativeBounceFormat::WavPcm { .. } => {
                    encode_wav(&request, 1, 1.0, 4_608, &mut progress, &cancel)
                }
                NativeBounceFormat::Flac { .. } => {
                    encode_flac(&request, 1, 1.0, 4_608, &mut progress, &cancel)
                }
                NativeBounceFormat::Mp3Cbr { .. } => {
                    encode_mp3(&request, 1, 1.0, 4_608, &mut progress, &cancel)
                }
                _ => unreachable!(),
            }
            .expect("encode deterministic fixture");
            let bytes = std::fs::read(&encoded_path).expect("read encoded fixture");
            match extension {
                "wav" => assert_eq!(&bytes[..4], b"RIFF"),
                "flac" => assert_eq!(&bytes[..4], b"fLaC"),
                "mp3" => assert!(
                    bytes
                        .windows(2)
                        .any(|frame| { frame[0] == 0xff && frame[1] & 0xe0 == 0xe0 })
                ),
                _ => unreachable!(),
            }
            std::fs::remove_file(encoded_path).expect("remove encoded fixture");
        }
        std::fs::remove_file(scratch_path).expect("remove encoder test scratch");
    }
}
