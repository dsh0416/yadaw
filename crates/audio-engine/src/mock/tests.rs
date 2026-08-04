use super::{
    Arc, BACKEND_ID, BufferSize, CHANNELS, DEFAULT_BUFFER_FRAMES, DeviceTrait, Duration, ErrorKind,
    HostTrait, Instant, MAX_BUFFER_FRAMES, MIN_BUFFER_FRAMES, MockDeviceKind, MockHost, Mutex,
    Ordering, SAMPLE_FORMAT, SAMPLE_RATE, StreamConfig, StreamTrait, SupportedBufferSize, host,
    is_mock_backend, negotiate_frames, thread,
};

fn fixed_config(frames: u32) -> StreamConfig {
    StreamConfig {
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        buffer_size: BufferSize::Fixed(frames),
    }
}

#[test]
fn recognizes_the_backend_identifier_case_insensitively() {
    assert!(is_mock_backend(BACKEND_ID));
    assert!(is_mock_backend("Mock"));
    assert!(!is_mock_backend("wasapi"));
    assert!(!is_mock_backend("mocked"));
}

#[test]
fn enumerates_duplex_capture_and_playback_devices() {
    let mock = MockHost::new();
    let ids = mock
        .devices()
        .unwrap()
        .map(|device| device.id().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        ids,
        [
            "custom:mock-duplex",
            "custom:mock-input",
            "custom:mock-output"
        ]
    );
}

#[test]
fn reports_the_duplex_device_as_the_default_for_both_directions() {
    let mock = MockHost::new();
    let input = mock.default_input_device().unwrap();
    let output = mock.default_output_device().unwrap();

    assert_eq!(input.id().unwrap().to_string(), "custom:mock-duplex");
    assert_eq!(output.id().unwrap().to_string(), "custom:mock-duplex");
    assert_eq!(input.to_string(), "Mock Duplex");
}

#[test]
fn filters_devices_by_the_directions_they_support() {
    let mock = MockHost::new();
    let inputs = mock
        .input_devices()
        .unwrap()
        .map(|device| device.id().unwrap().to_string())
        .collect::<Vec<_>>();
    let outputs = mock
        .output_devices()
        .unwrap()
        .map(|device| device.id().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(inputs, ["custom:mock-duplex", "custom:mock-input"]);
    assert_eq!(outputs, ["custom:mock-duplex", "custom:mock-output"]);
}

#[test]
fn advertises_a_single_stereo_configuration_with_a_buffer_range() {
    let mock = MockHost::new();
    let device = mock.default_output_device().unwrap();
    let config = device.default_output_config().unwrap();

    assert_eq!(config.channels(), CHANNELS);
    assert_eq!(config.sample_rate(), SAMPLE_RATE);
    assert_eq!(config.sample_format(), SAMPLE_FORMAT);
    assert_eq!(
        *config.buffer_size(),
        SupportedBufferSize::Range {
            min: MIN_BUFFER_FRAMES,
            max: MAX_BUFFER_FRAMES,
        }
    );
    assert_eq!(device.supported_output_configs().unwrap().count(), 1);
}

#[test]
fn rejects_directions_a_device_does_not_support() {
    let mock = MockHost::new();
    let capture_only = mock.device(MockDeviceKind::Input);
    let playback_only = mock.device(MockDeviceKind::Output);

    assert_eq!(
        capture_only.default_output_config().unwrap_err().kind(),
        ErrorKind::UnsupportedOperation
    );
    assert_eq!(
        playback_only.default_input_config().unwrap_err().kind(),
        ErrorKind::UnsupportedOperation
    );
    assert_eq!(capture_only.supported_output_configs().unwrap().count(), 0);
    assert_eq!(playback_only.supported_input_configs().unwrap().count(), 0);
}

#[test]
fn negotiates_the_requested_block_size_within_the_supported_range() {
    assert_eq!(
        negotiate_frames(&fixed_config(128), SAMPLE_FORMAT).unwrap(),
        128
    );
    assert_eq!(
        negotiate_frames(&fixed_config(MIN_BUFFER_FRAMES), SAMPLE_FORMAT).unwrap(),
        MIN_BUFFER_FRAMES
    );
    assert_eq!(
        negotiate_frames(&fixed_config(MAX_BUFFER_FRAMES), SAMPLE_FORMAT).unwrap(),
        MAX_BUFFER_FRAMES
    );

    let default_buffer = StreamConfig {
        buffer_size: BufferSize::Default,
        ..fixed_config(128)
    };
    assert_eq!(
        negotiate_frames(&default_buffer, SAMPLE_FORMAT).unwrap(),
        DEFAULT_BUFFER_FRAMES
    );
}

#[test]
fn rejects_configurations_the_mock_devices_do_not_advertise() {
    let unsupported_format =
        negotiate_frames(&fixed_config(128), cpal::SampleFormat::I16).unwrap_err();
    let unsupported_rate = StreamConfig {
        sample_rate: 96_000,
        ..fixed_config(128)
    };
    let unsupported_channels = StreamConfig {
        channels: 8,
        ..fixed_config(128)
    };

    assert_eq!(unsupported_format.kind(), ErrorKind::UnsupportedConfig);
    assert_eq!(
        negotiate_frames(&unsupported_rate, SAMPLE_FORMAT)
            .unwrap_err()
            .kind(),
        ErrorKind::UnsupportedConfig
    );
    assert_eq!(
        negotiate_frames(&unsupported_channels, SAMPLE_FORMAT)
            .unwrap_err()
            .kind(),
        ErrorKind::UnsupportedConfig
    );
    assert_eq!(
        negotiate_frames(&fixed_config(MAX_BUFFER_FRAMES + 1), SAMPLE_FORMAT)
            .unwrap_err()
            .kind(),
        ErrorKind::UnsupportedConfig
    );
}

#[test]
fn resolves_the_backend_as_a_cpal_host_without_advertising_availability() {
    // cpal deliberately hides custom hosts from `available_hosts`, so the
    // engine has to resolve the mock backend by name instead.
    assert!(
        !cpal::available_hosts()
            .iter()
            .any(|host_id| host_id.to_string() == "custom")
    );

    let host = host();
    let device = host.default_output_device().unwrap();
    assert_eq!(device.id().unwrap().to_string(), "custom:mock-duplex");
}

#[test]
fn holds_streams_paused_until_they_are_played() {
    let mock = MockHost::new();
    let device = mock.default_output_device().unwrap();
    let callbacks = Arc::new(AtomicU32Counter::default());
    let counter = Arc::clone(&callbacks);
    let stream = device
        .build_output_stream(
            fixed_config(64),
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                assert_eq!(data.len(), 64 * usize::from(CHANNELS));
                counter.increment();
            },
            |error| panic!("unexpected mock stream error: {error}"),
            None,
        )
        .unwrap();

    assert_eq!(stream.buffer_size().unwrap(), 64);
    thread::sleep(SETTLE);
    assert_eq!(
        callbacks.get(),
        0,
        "a stream must stay silent until it is played"
    );

    stream.play().unwrap();
    assert!(
        wait_for(|| callbacks.get() > 0),
        "playing the stream did not start the data callback"
    );

    stream.pause().unwrap();
    // Pausing stops the worker promptly but not instantly: a block already
    // in flight still reaches the callback, exactly as a real backend may
    // deliver one more buffer after `pause` returns. What must hold is that
    // the callback count settles instead of continuing to climb.
    assert!(
        callbacks_settle(&callbacks),
        "a paused stream must stop calling back"
    );
}

#[test]
fn advances_stream_time_monotonically() {
    let mock = MockHost::new();
    let device = mock.default_output_device().unwrap();
    let stream = device
        .build_output_stream(
            fixed_config(64),
            |_: &mut [f32], _: &cpal::OutputCallbackInfo| {},
            |error| panic!("unexpected mock stream error: {error}"),
            None,
        )
        .unwrap();

    let first = stream.now();
    thread::sleep(Duration::from_millis(5));
    assert!(stream.now() > first);
}

#[test]
fn loops_playback_back_into_capture() {
    let mock = MockHost::new();
    let device = mock.default_input_device().unwrap();
    let played = Arc::new(AtomicU32Counter::default());
    let playing = Arc::clone(&played);
    let captured = Arc::new(Mutex::new(Vec::<f32>::new()));
    let capturing = Arc::clone(&captured);

    let input = device
        .build_input_stream(
            fixed_config(64),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mut captured = capturing.lock().unwrap();
                captured.extend(data.iter().copied().filter(|sample| *sample != 0.0));
            },
            |error| panic!("unexpected mock stream error: {error}"),
            None,
        )
        .unwrap();
    let output = device
        .build_output_stream(
            fixed_config(64),
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                playing.increment();
                data.fill(0.5);
            },
            |error| panic!("unexpected mock stream error: {error}"),
            None,
        )
        .unwrap();
    input.play().unwrap();
    output.play().unwrap();

    assert!(
        wait_for(|| captured.lock().unwrap().len() >= 64),
        "capture never observed the played signal"
    );
    assert!(played.get() > 0);
    assert!(
        captured
            .lock()
            .unwrap()
            .iter()
            .all(|sample| (sample - 0.5).abs() < f32::EPSILON),
        "capture observed samples that were never played"
    );
}

#[test]
fn keeps_capture_running_without_a_playback_stream() {
    let mock = MockHost::new();
    let device = mock.device(MockDeviceKind::Input);
    let callbacks = Arc::new(AtomicU32Counter::default());
    let counter = Arc::clone(&callbacks);
    let stream = device
        .build_input_stream(
            fixed_config(64),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                assert!(
                    data.iter().all(|sample| *sample == 0.0),
                    "capture without playback must be silent"
                );
                counter.increment();
            },
            |error| panic!("unexpected mock stream error: {error}"),
            None,
        )
        .unwrap();
    stream.play().unwrap();

    assert!(
        wait_for(|| callbacks.get() >= 2),
        "capture did not fall back to the block clock"
    );
}

#[derive(Default)]
struct AtomicU32Counter(std::sync::atomic::AtomicU32);

impl AtomicU32Counter {
    fn increment(&self) {
        self.0.fetch_add(1, Ordering::Release);
    }

    fn get(&self) -> u32 {
        self.0.load(Ordering::Acquire)
    }
}

fn wait_for(mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if ready() {
            return true;
        }
        thread::sleep(Duration::from_millis(1));
    }
    false
}

/// Long enough to observe several blocks of the buffer sizes used here, even
/// where the platform sleep granularity is tens of milliseconds.
const SETTLE: Duration = Duration::from_millis(50);

/// Whether the callback count stops changing across a [`SETTLE`] window.
///
/// A running stream keeps incrementing the counter, so the window never
/// stabilises and this returns `false` once the deadline passes.
fn callbacks_settle(callbacks: &AtomicU32Counter) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let before = callbacks.get();
        thread::sleep(SETTLE);
        if callbacks.get() == before {
            return true;
        }
    }
    false
}
