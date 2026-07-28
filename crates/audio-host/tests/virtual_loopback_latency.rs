use std::{thread, time::Duration};

use yadaw_audio_host::engine::{
    NativeAudioEngineConfig, NativeRoundTripLatencyMeasurementRequest,
    round_trip_latency_measurement_snapshot, start_audio_engine,
    start_round_trip_latency_measurement, stop_audio_engine,
};

#[test]
fn virtual_backend_completes_a_physical_loopback_measurement() {
    // SAFETY: This integration test is its own process and sets the opt-in
    // before the virtual audio worker or any other thread is spawned.
    unsafe {
        std::env::set_var("YADAW_TEST_VIRTUAL_AUDIO", "1");
    }
    start_audio_engine(NativeAudioEngineConfig {
        backend: "virtual".to_owned(),
        input_device_id: "virtual-input".to_owned(),
        output_device_id: "virtual-output".to_owned(),
        buffer_size: 128,
        session_sample_rate: Some(48_000),
    })
    .unwrap();
    start_round_trip_latency_measurement(NativeRoundTripLatencyMeasurementRequest {
        input_channel: 1,
        output_channel: 1,
    })
    .unwrap();

    let mut completed = None;
    for _ in 0..100 {
        let snapshot = round_trip_latency_measurement_snapshot().unwrap();
        if snapshot.status == "complete" {
            completed = snapshot.measured_round_trip_latency_ms;
            break;
        }
        assert_ne!(snapshot.status, "failed", "{:?}", snapshot.failure);
        thread::sleep(Duration::from_millis(10));
    }

    let measured = completed.expect("virtual loopback should complete");
    assert!(measured > 0.0 && measured < 100.0, "{measured}");
    stop_audio_engine().unwrap();
}
