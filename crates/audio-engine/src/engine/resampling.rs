use super::{
    Adjustable, Arc, Async, Consumer, Device, DeviceTrait, EngineCommand, FixedAsync, FromSample,
    HardwareOutputFrame, HeapCons, HeapProd, INPUT_RESAMPLER_OUTPUT_FRAMES, InputFrame,
    InputPeakBank, InterleavedSlice, MAX_INPUT_CHANNELS, MAX_OUTPUT_CHANNELS,
    MAX_PLUGIN_BLOCK_FRAMES, OUTPUT_RESAMPLER_FRAMES, Observer, Ordering, OutputMixerControl,
    OutputStreamContext, Producer, Resampler, Result, RoundTripInputDetector,
    RoundTripLatencyMeasurement, RoundTripOutputProbe, RuntimeMetrics, Sample,
    SincInterpolationParameters, SizedSample, Stream, StreamConfig, StreamDirection,
    UNKNOWN_LATENCY_US, audio_error, duration_to_micros, frames_to_micros, frames_to_nanos,
    invalid_config, mark_stream_error,
};

pub(super) struct AdaptiveResampler {
    pub(super) consumer: HeapCons<InputFrame>,
    pub(super) resampler: Async<f32>,
    pub(super) input_channels: usize,
    pub(super) input_buffer: Vec<f32>,
    pub(super) output_buffer: Vec<f32>,
    pub(super) output_cursor: usize,
    pub(super) output_frames: usize,
    pub(super) target_fill: usize,
    pub(super) capacity: usize,
}

impl AdaptiveResampler {
    pub(super) fn new(
        consumer: HeapCons<InputFrame>,
        input_sample_rate: u32,
        output_sample_rate: u32,
        input_channels: usize,
        target_fill: usize,
        capacity: usize,
    ) -> Result<Self> {
        let input_channels = input_channels.clamp(1, MAX_INPUT_CHANNELS);
        let nominal_ratio = f64::from(output_sample_rate) / f64::from(input_sample_rate);
        let resampler = Async::<f32>::new_sinc(
            nominal_ratio,
            1.002,
            &SincInterpolationParameters::default(),
            INPUT_RESAMPLER_OUTPUT_FRAMES,
            input_channels,
            FixedAsync::Output,
        )
        .map_err(|error| invalid_config(error.to_string()))?;
        let input_buffer = vec![0.0; resampler.input_frames_max() * input_channels];
        let output_buffer = vec![0.0; resampler.output_frames_max() * input_channels];
        Ok(Self {
            consumer,
            resampler,
            input_channels,
            input_buffer,
            output_buffer,
            output_cursor: 0,
            output_frames: 0,
            target_fill,
            capacity,
        })
    }

    pub(super) fn occupied_len(&self) -> usize {
        self.consumer.occupied_len()
    }

    pub(super) fn output_delay(&self) -> usize {
        self.resampler.output_delay()
    }

    pub(super) fn adaptive_relative_ratio(&self) -> f64 {
        let fill_error = self.occupied_len() as f64 - self.target_fill as f64;
        let normalized_error = fill_error / self.capacity.max(1) as f64;
        let drift_correction = (normalized_error * 0.002).clamp(-0.001, 0.001);
        1.0 / (1.0 + drift_correction)
    }

    pub(super) fn refill(&mut self) -> bool {
        let relative_ratio = self.adaptive_relative_ratio();
        if self
            .resampler
            .set_resample_ratio_relative(relative_ratio, true)
            .is_err()
        {
            self.output_buffer.fill(0.0);
            self.output_frames = INPUT_RESAMPLER_OUTPUT_FRAMES;
            self.output_cursor = 0;
            self.resampler.reset();
            return true;
        }

        let required = self.resampler.input_frames_next();
        let output_frames = self.resampler.output_frames_next();
        self.input_buffer[..required * self.input_channels].fill(0.0);
        let mut available = 0;
        while available < required {
            let Some(frame) = self.consumer.try_pop() else {
                break;
            };
            let offset = available * self.input_channels;
            self.input_buffer[offset..offset + self.input_channels]
                .copy_from_slice(&frame[..self.input_channels]);
            available += 1;
        }
        self.output_buffer[..output_frames * self.input_channels].fill(0.0);
        let processed = {
            let Ok(input) = InterleavedSlice::new(
                &self.input_buffer[..required * self.input_channels],
                self.input_channels,
                required,
            ) else {
                return true;
            };
            let Ok(mut output) = InterleavedSlice::new_mut(
                &mut self.output_buffer[..output_frames * self.input_channels],
                self.input_channels,
                output_frames,
            ) else {
                return true;
            };
            self.resampler
                .process_into_buffer(&input, &mut output, None)
        };
        match processed {
            Ok((_consumed, produced)) => {
                self.output_cursor = 0;
                self.output_frames = produced;
            }
            Err(_) => {
                self.output_buffer.fill(0.0);
                self.output_cursor = 0;
                self.output_frames = output_frames;
                self.resampler.reset();
                return true;
            }
        }
        available < required
    }

    pub(super) fn next_frame(&mut self) -> (InputFrame, bool) {
        let mut underrun = false;
        if self.output_cursor >= self.output_frames {
            underrun = self.refill();
        }
        if self.output_cursor >= self.output_frames {
            return ([0.0; MAX_INPUT_CHANNELS], true);
        }
        let mut frame = [0.0; MAX_INPUT_CHANNELS];
        let offset = self.output_cursor * self.input_channels;
        frame[..self.input_channels]
            .copy_from_slice(&self.output_buffer[offset..offset + self.input_channels]);
        self.output_cursor += 1;
        (frame, underrun)
    }
}

pub(super) struct SessionOutputResampler {
    pub(super) resampler: Async<f32>,
    pub(super) channels: usize,
    pub(super) session_buffer: Vec<HardwareOutputFrame>,
    pub(super) input_buffer: Vec<f32>,
    pub(super) output_buffer: Vec<f32>,
    pub(super) output_cursor: usize,
    pub(super) output_frames: usize,
}

// Keeping the resampler inline avoids an extra indirection while filling each
// output block; the converter and all scratch are allocated during startup.
#[allow(clippy::large_enum_variant)]
pub(super) enum SessionOutputConverter {
    Bypass,
    Resampled(SessionOutputResampler),
}

impl SessionOutputConverter {
    pub(super) fn new(
        session_sample_rate: u32,
        output_sample_rate: u32,
        channels: usize,
    ) -> Result<Self> {
        if session_sample_rate == output_sample_rate {
            return Ok(Self::Bypass);
        }
        let channels = channels.clamp(1, MAX_OUTPUT_CHANNELS);
        let ratio = f64::from(output_sample_rate) / f64::from(session_sample_rate);
        let resampler = Async::<f32>::new_sinc(
            ratio,
            1.0,
            &SincInterpolationParameters::default(),
            OUTPUT_RESAMPLER_FRAMES,
            channels,
            FixedAsync::Output,
        )
        .map_err(|error| invalid_config(error.to_string()))?;
        let session_buffer = vec![[0.0; MAX_OUTPUT_CHANNELS]; resampler.input_frames_max()];
        let input_buffer = vec![0.0; resampler.input_frames_max() * channels];
        let output_buffer = vec![0.0; resampler.output_frames_max() * channels];
        Ok(Self::Resampled(SessionOutputResampler {
            resampler,
            channels,
            session_buffer,
            input_buffer,
            output_buffer,
            output_cursor: 0,
            output_frames: 0,
        }))
    }

    pub(super) fn output_delay(&self) -> usize {
        match self {
            Self::Bypass => 0,
            Self::Resampled(resampler) => resampler.resampler.output_delay(),
        }
    }

    pub(super) fn render_block(
        &mut self,
        output: &mut [HardwareOutputFrame],
        mut render: impl FnMut(&mut [HardwareOutputFrame]) -> bool,
    ) -> (bool, usize) {
        match self {
            Self::Bypass => {
                let rendered_frames = output.len();
                (render(output), rendered_frames)
            }
            Self::Resampled(resampler) => resampler.render_block(output, render),
        }
    }
}

impl SessionOutputResampler {
    pub(super) fn refill(
        &mut self,
        mut render: impl FnMut(&mut [HardwareOutputFrame]) -> bool,
    ) -> (bool, usize) {
        let required = self.resampler.input_frames_next();
        let output_frames = self.resampler.output_frames_next();
        self.input_buffer[..required * self.channels].fill(0.0);
        let mut underrun = false;
        for block in self.session_buffer[..required].chunks_mut(MAX_PLUGIN_BLOCK_FRAMES) {
            underrun |= render(block);
        }
        for (frame_index, frame) in self.session_buffer[..required].iter().enumerate() {
            let offset = frame_index * self.channels;
            self.input_buffer[offset..offset + self.channels]
                .copy_from_slice(&frame[..self.channels]);
        }
        self.output_buffer[..output_frames * self.channels].fill(0.0);
        let processed = {
            let Ok(input) = InterleavedSlice::new(
                &self.input_buffer[..required * self.channels],
                self.channels,
                required,
            ) else {
                return (true, required);
            };
            let Ok(mut output) = InterleavedSlice::new_mut(
                &mut self.output_buffer[..output_frames * self.channels],
                self.channels,
                output_frames,
            ) else {
                return (true, required);
            };
            self.resampler
                .process_into_buffer(&input, &mut output, None)
        };
        match processed {
            Ok((_consumed, produced)) => {
                self.output_cursor = 0;
                self.output_frames = produced;
            }
            Err(_) => {
                self.output_buffer.fill(0.0);
                self.output_cursor = 0;
                self.output_frames = output_frames;
                self.resampler.reset();
                underrun = true;
            }
        }
        (underrun, required)
    }

    pub(super) fn render_block(
        &mut self,
        output: &mut [HardwareOutputFrame],
        mut render: impl FnMut(&mut [HardwareOutputFrame]) -> bool,
    ) -> (bool, usize) {
        let mut underrun = false;
        let mut rendered_frames = 0;
        for frame in output {
            if self.output_cursor >= self.output_frames {
                let (refill_underrun, refill_frames) = self.refill(&mut render);
                underrun |= refill_underrun;
                rendered_frames += refill_frames;
            }
            if self.output_cursor >= self.output_frames {
                *frame = [0.0; MAX_OUTPUT_CHANNELS];
                underrun = true;
                continue;
            }
            let offset = self.output_cursor * self.channels;
            frame[..self.channels]
                .copy_from_slice(&self.output_buffer[offset..offset + self.channels]);
            frame[self.channels..].fill(0.0);
            self.output_cursor += 1;
        }
        (underrun, rendered_frames)
    }
}

pub(super) fn build_input_stream<T>(
    device: &Device,
    config: &StreamConfig,
    mut producer: HeapProd<InputFrame>,
    metrics: Arc<RuntimeMetrics>,
    input_peaks: Arc<InputPeakBank>,
    round_trip_latency: Arc<RoundTripLatencyMeasurement>,
) -> Result<Stream>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    let callback_metrics = Arc::clone(&metrics);
    let error_metrics = Arc::clone(&metrics);
    let mut round_trip_detector = RoundTripInputDetector::new(round_trip_latency);

    device
        .build_input_stream(
            *config,
            move |data: &[T], info| {
                let callback_started_ns = round_trip_detector.shared.now_ns();
                let timestamp = info.timestamp();
                callback_metrics.input_latency_us.store(
                    duration_to_micros(timestamp.callback.duration_since(timestamp.capture)),
                    Ordering::Relaxed,
                );

                for (frame_index, frame) in data.chunks_exact(channels).enumerate() {
                    let mut capture = [0.0_f32; MAX_INPUT_CHANNELS];
                    let capture_channels = channels.min(MAX_INPUT_CHANNELS);
                    for (target, source) in capture[..capture_channels].iter_mut().zip(frame) {
                        *target = f32::from_sample(*source);
                    }
                    let _ = producer.try_push(capture);
                    input_peaks.observe(&capture[..capture_channels]);
                    round_trip_detector.observe(
                        &capture[..capture_channels],
                        callback_started_ns.saturating_add(frames_to_nanos(
                            frame_index,
                            callback_metrics.input_sample_rate,
                        )),
                    );
                }

                callback_metrics
                    .ring_buffer_fill_frames
                    .store(producer.occupied_len() as u32, Ordering::Relaxed);
            },
            move |error| mark_stream_error(&error_metrics, StreamDirection::Input, &error),
            None,
        )
        .map_err(|error| audio_error("failed to build cpal input stream", error))
}

pub(super) fn build_output_stream<T>(
    device: &Device,
    config: &StreamConfig,
    consumer: HeapCons<InputFrame>,
    input_channels: usize,
    target_fill: usize,
    context: OutputStreamContext,
) -> Result<Stream>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let OutputStreamContext {
        metrics,
        mixer_control,
        round_trip_latency,
        mut recording_tap,
    } = context;
    let OutputMixerControl {
        mut commands,
        mut mixer,
        mut retired_mixers,
    } = mixer_control;
    let channels = usize::from(config.channels);
    let mut resampler = AdaptiveResampler::new(
        consumer,
        metrics.input_sample_rate,
        metrics.sample_rate,
        input_channels,
        target_fill,
        metrics.ring_buffer_capacity_frames as usize,
    )?;
    let mut output_converter =
        SessionOutputConverter::new(metrics.sample_rate, metrics.output_sample_rate, channels)?;
    metrics.engine_latency_us.store(
        frames_to_micros(resampler.output_delay(), metrics.sample_rate).saturating_add(
            frames_to_micros(output_converter.output_delay(), metrics.output_sample_rate),
        ),
        Ordering::Relaxed,
    );
    let callback_metrics = Arc::clone(&metrics);
    let error_metrics = Arc::clone(&metrics);
    let mut round_trip_probe = RoundTripOutputProbe::new(round_trip_latency);
    let mut realtime_midi = crate::midi_input::realtime_consumer();
    let mut render_inputs = vec![[0.0; MAX_INPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES];
    let mut device_outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES];

    device
        .build_output_stream(
            *config,
            move |data: &mut [T], info| {
                let callback_started_ns = round_trip_probe.shared.now_ns();
                let timestamp = info.timestamp();
                callback_metrics.output_latency_us.store(
                    duration_to_micros(timestamp.playback.duration_since(timestamp.callback)),
                    Ordering::Relaxed,
                );
                let output_latency = callback_metrics.output_latency_us.load(Ordering::Relaxed);
                realtime_midi.set_presentation_latency_micros(
                    callback_metrics
                        .engine_latency_us
                        .load(Ordering::Relaxed)
                        .saturating_add(if output_latency != UNKNOWN_LATENCY_US {
                            output_latency
                        } else {
                            0
                        }),
                );

                let external_sync_enabled = realtime_midi.external_sync_enabled();
                if let Some(runtime) = mixer.as_mut() {
                    runtime.external_sync_enabled = external_sync_enabled;
                }

                while let Some(command) = commands.try_pop() {
                    if let Some(runtime) = mixer.as_mut() {
                        if let Some(replacement) = runtime.handle_command(command) {
                            callback_metrics
                                .published_graph_generation
                                .store(replacement.generation, Ordering::Release);
                            callback_metrics
                                .published_graph_build_generation
                                .store(replacement.build_generation, Ordering::Release);
                            if let Some(mut retired) = mixer.replace(replacement) {
                                retired.retire_plugin_processors();
                                if let Err(retired) = retired_mixers.try_push(retired) {
                                    // Graph retirement should never block the audio callback. A
                                    // saturated queue means the control thread has stopped polling;
                                    // leaking is safer than deallocating a large graph here.
                                    std::mem::forget(retired);
                                }
                            }
                        }
                    } else if let EngineCommand::LoadMixer(mut runtime) = command {
                        runtime.external_sync_enabled = external_sync_enabled;
                        runtime.activate_application_captures();
                        callback_metrics
                            .published_graph_generation
                            .store(runtime.generation, Ordering::Release);
                        callback_metrics
                            .published_graph_build_generation
                            .store(runtime.build_generation, Ordering::Release);
                        mixer = Some(runtime);
                    }
                }

                let mut underrun = false;
                let mut rendered_session_frames = 0;
                let total_frames = data.len() / channels;
                let mut device_frame_offset = 0;
                while device_frame_offset < total_frames {
                    let block_frames =
                        (total_frames - device_frame_offset).min(MAX_PLUGIN_BLOCK_FRAMES);
                    let (block_underrun, rendered_frames) = output_converter.render_block(
                        &mut device_outputs[..block_frames],
                        |session_outputs| {
                            for target in &mut render_inputs[..session_outputs.len()] {
                                // A dry input bridge is zero-filled. When the graph does not
                                // monitor that input it cannot affect the rendered output.
                                let (input, _input_underrun) = resampler.next_frame();
                                *target = input;
                            }
                            if let Some(runtime) = mixer.as_mut() {
                                runtime.render_block(
                                    &render_inputs[..session_outputs.len()],
                                    session_outputs,
                                    Some(&mut realtime_midi),
                                    Some(&mut recording_tap),
                                )
                            } else {
                                session_outputs.fill([0.0; MAX_OUTPUT_CHANNELS]);
                                false
                            }
                        },
                    );
                    underrun |= block_underrun;
                    rendered_session_frames += rendered_frames;

                    let sample_start = device_frame_offset * channels;
                    let sample_end = sample_start + block_frames * channels;
                    for (local_frame, (frame, rendered)) in data[sample_start..sample_end]
                        .chunks_exact_mut(channels)
                        .zip(&mut device_outputs[..block_frames])
                        .enumerate()
                    {
                        round_trip_probe.apply(
                            &mut rendered[..channels.min(MAX_OUTPUT_CHANNELS)],
                            callback_started_ns.saturating_add(frames_to_nanos(
                                device_frame_offset + local_frame,
                                callback_metrics.output_sample_rate,
                            )),
                        );
                        for (channel, sample) in frame.iter_mut().enumerate() {
                            let value = rendered
                                .get(channel)
                                .copied()
                                .unwrap_or(0.0)
                                .clamp(-1.0, 1.0);
                            *sample = T::from_sample(value);
                        }
                    }
                    device_frame_offset += block_frames;
                }
                if let Some(runtime) = mixer.as_mut() {
                    runtime.publish_peaks(rendered_session_frames);
                }

                callback_metrics
                    .ring_buffer_fill_frames
                    .store(resampler.occupied_len() as u32, Ordering::Relaxed);
                if underrun {
                    callback_metrics.xruns.fetch_add(1, Ordering::Relaxed);
                }
                callback_metrics
                    .callback_generation
                    .fetch_add(1, Ordering::Release);
            },
            move |error| mark_stream_error(&error_metrics, StreamDirection::Output, &error),
            None,
        )
        .map_err(|error| audio_error("failed to build cpal output stream", error))
}

macro_rules! build_stream_for_format {
    ($builder:ident, $format:expr, $($args:expr),+ $(,)?) => {
        match $format {
            SampleFormat::I8 => $builder::<i8>($($args),+),
            SampleFormat::I16 => $builder::<i16>($($args),+),
            SampleFormat::I24 => $builder::<cpal::I24>($($args),+),
            SampleFormat::I32 => $builder::<i32>($($args),+),
            SampleFormat::I64 => $builder::<i64>($($args),+),
            SampleFormat::U8 => $builder::<u8>($($args),+),
            SampleFormat::U16 => $builder::<u16>($($args),+),
            SampleFormat::U24 => $builder::<cpal::U24>($($args),+),
            SampleFormat::U32 => $builder::<u32>($($args),+),
            SampleFormat::U64 => $builder::<u64>($($args),+),
            SampleFormat::F32 => $builder::<f32>($($args),+),
            SampleFormat::F64 => $builder::<f64>($($args),+),
            SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => {
                Err(invalid_config("DSD audio streams are not supported"))
            }
            _ => Err(invalid_config("unsupported cpal sample format")),
        }
    };
}

pub(super) use build_stream_for_format;
