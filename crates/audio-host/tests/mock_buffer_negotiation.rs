use std::{
    thread,
    time::{Duration, Instant},
};

use yadaw_audio_host::engine::{AudioEngine, NativeAudioEngineConfig, NativeAudioRuntimeSnapshot};
use yadaw_audio_host::mock;

/// The block sizes the mock devices advertise.
const MOCK_MIN_BUFFER_FRAMES: u32 = 32;
const MOCK_MAX_BUFFER_FRAMES: u32 = 2_048;

fn start(engine: &AudioEngine, buffer_size: u32) -> NativeAudioRuntimeSnapshot {
    engine
        .start_audio_engine(NativeAudioEngineConfig {
            backend: mock::BACKEND_ID.to_owned(),
            input_device_id: "custom:mock-duplex".to_owned(),
            output_device_id: "custom:mock-duplex".to_owned(),
            buffer_size,
            session_sample_rate: Some(48_000),
        })
        .unwrap()
}

/// Waits for the callbacks to run, which only advance once both streams are
/// delivering blocks of the negotiated size.
fn await_callbacks(engine: &AudioEngine) {
    let (start_generation, _) = engine.heartbeat_snapshot();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (generation, _) = engine.heartbeat_snapshot();
        if generation > start_generation {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "mock audio callbacks did not advance before the timeout"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

// Reuse one owned engine so the cases also cover stop/reconfigure cleanup.
#[test]
fn buffer_requests_negotiate_a_block_size_the_mock_devices_deliver() {
    let engine = AudioEngine::new();
    // A request the device cannot honour must still leave the engine and the
    // streams agreeing on one block size. Reporting the clamped size while the
    // callbacks ran at the driver default would mis-size the input ring buffer
    // and the adaptive resampler.
    let below_range = start(&engine, 16);
    assert_eq!(below_range.state, "running");
    assert_eq!(below_range.requested_buffer_size, Some(16));
    assert_eq!(below_range.input_buffer_size, Some(MOCK_MIN_BUFFER_FRAMES));
    assert_eq!(below_range.output_buffer_size, Some(MOCK_MIN_BUFFER_FRAMES));
    assert!(
        below_range.buffer_fallback,
        "a clamped request must be reported as a fallback"
    );
    await_callbacks(&engine);
    engine.stop_audio_engine().unwrap();

    let above_range = start(&engine, MOCK_MAX_BUFFER_FRAMES * 2);
    assert_eq!(above_range.state, "running");
    assert_eq!(above_range.input_buffer_size, Some(MOCK_MAX_BUFFER_FRAMES));
    assert_eq!(above_range.output_buffer_size, Some(MOCK_MAX_BUFFER_FRAMES));
    assert!(above_range.buffer_fallback);
    await_callbacks(&engine);
    engine.stop_audio_engine().unwrap();

    let supported = start(&engine, 128);
    assert_eq!(supported.state, "running");
    assert_eq!(supported.requested_buffer_size, Some(128));
    assert_eq!(supported.input_buffer_size, Some(128));
    assert_eq!(supported.output_buffer_size, Some(128));
    assert!(
        !supported.buffer_fallback,
        "a supported request must not be reported as a fallback"
    );
    await_callbacks(&engine);
    engine.stop_audio_engine().unwrap();
}
