use super::*;

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

pub(super) fn base_peak_level(samples: &[f32], channels: usize) -> Vec<f32> {
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

pub(super) fn build_waveform_levels(samples: &[f32], channels: usize) -> Vec<NativeWaveformLevel> {
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
pub(super) struct LiveWaveform {
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

    pub(super) fn reset(&mut self, sample_rate: u32, channels: usize) {
        self.sample_rate = sample_rate;
        self.channels = channels;
        self.frame_count = 0;
        self.base_peaks.clear();
        self.reset_pending();
    }

    pub(super) fn push(&mut self, samples: &[f32]) {
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

    pub(super) fn snapshot(
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
