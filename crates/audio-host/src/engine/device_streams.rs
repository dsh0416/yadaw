fn host_for_backend(backend: &str) -> Result<Host> {
    let host_id = cpal::available_hosts()
        .into_iter()
        .find(|host_id| host_id.to_string().eq_ignore_ascii_case(backend))
        .ok_or_else(|| invalid_config(format!("cpal backend '{backend}' is not available")))?;

    cpal::host_from_id(host_id)
        .map_err(|error| audio_error("failed to initialize cpal host", error))
}

fn find_device(host: &Host, id: &str, input: bool) -> Result<Device> {
    let devices = if input {
        host.input_devices()
            .map_err(|error| audio_error("failed to enumerate input devices", error))?
            .collect::<Vec<_>>()
    } else {
        host.output_devices()
            .map_err(|error| audio_error("failed to enumerate output devices", error))?
            .collect::<Vec<_>>()
    };

    devices
        .into_iter()
        .find(|device| {
            device
                .id()
                .is_ok_and(|device_id| device_id.to_string() == id)
        })
        .ok_or_else(|| invalid_config(format!("audio device '{id}' is no longer available")))
}

fn resolve_stream_devices<T: Clone>(
    backend: &str,
    input_device_id: &str,
    output_device_id: &str,
    mut find: impl FnMut(&str, bool) -> Result<T>,
) -> Result<(T, T)> {
    if backend.eq_ignore_ascii_case("asio") {
        if input_device_id != output_device_id {
            return Err(invalid_config(
                "ASIO input and output must use the same driver",
            ));
        }
        // CPAL's ASIO Device clone shares the same AsioStreams allocation. ASIO requires input
        // and output buffers to be created together; independently enumerated Device values own
        // distinct stream state, so creating the output stream can invalidate the input buffers.
        let device = find(input_device_id, true)?;
        return Ok((device.clone(), device));
    }

    Ok((find(input_device_id, true)?, find(output_device_id, false)?))
}

struct BufferSelection {
    buffer_size: BufferSize,
    expected_frames: u32,
    fell_back: bool,
}

fn select_buffer_size(supported: &SupportedBufferSize, requested: u32) -> BufferSelection {
    match supported {
        SupportedBufferSize::Range { min, max } => {
            let selected = requested.clamp(*min, *max);
            if selected == requested {
                BufferSelection {
                    buffer_size: BufferSize::Fixed(selected),
                    expected_frames: selected,
                    fell_back: false,
                }
            } else {
                BufferSelection {
                    buffer_size: BufferSize::Default,
                    expected_frames: selected,
                    fell_back: true,
                }
            }
        }
        SupportedBufferSize::Unknown => BufferSelection {
            buffer_size: BufferSize::Default,
            expected_frames: requested,
            fell_back: true,
        },
    }
}

fn stream_config(
    config: &SupportedStreamConfig,
    requested_buffer_size: u32,
) -> (StreamConfig, BufferSelection) {
    let selection = select_buffer_size(config.buffer_size(), requested_buffer_size);
    let mut stream_config = config.config();
    stream_config.buffer_size = selection.buffer_size;
    (stream_config, selection)
}

fn duration_to_micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX - 1)) as u64
}

fn optional_latency(value: u64) -> Option<u64> {
    (value != UNKNOWN_LATENCY_US).then_some(value)
}

fn frames_to_ms(frames: u32, sample_rate: u32) -> f64 {
    f64::from(frames) / f64::from(sample_rate) * 1_000.0
}

fn frames_to_micros(frames: usize, sample_rate: u32) -> u64 {
    ((frames as u128).saturating_mul(1_000_000) / u128::from(sample_rate)).min(u128::from(u64::MAX))
        as u64
}

fn frames_to_nanos(frames: usize, sample_rate: u32) -> u64 {
    ((frames as u128).saturating_mul(1_000_000_000) / u128::from(sample_rate))
        .min(u128::from(u64::MAX)) as u64
}

fn mark_stream_error(metrics: &RuntimeMetrics) {
    metrics.xruns.fetch_add(1, Ordering::Relaxed);
    metrics.faulted.store(true, Ordering::Relaxed);
}
