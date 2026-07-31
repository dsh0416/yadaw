use std::{thread, time::Duration};

use yadaw_audio_host::engine::{
    NativeAudioEngineConfig, NativeRoundTripLatencyMeasurementRequest,
    round_trip_latency_measurement_snapshot, start_audio_engine,
    start_round_trip_latency_measurement, stop_audio_engine,
};
use yadaw_audio_host::mock;

#[test]
fn mock_backend_completes_a_loopback_measurement_through_its_duplex_device() {
    start_audio_engine(NativeAudioEngineConfig {
        backend: mock::BACKEND_ID.to_owned(),
        input_device_id: "custom:mock-duplex".to_owned(),
        output_device_id: "custom:mock-duplex".to_owned(),
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
    for _ in 0..500 {
        let snapshot = round_trip_latency_measurement_snapshot().unwrap();
        if snapshot.status == "complete" {
            completed = snapshot.measured_round_trip_latency_ms;
            break;
        }
        assert_ne!(snapshot.status, "failed", "{:?}", snapshot.failure);
        thread::sleep(Duration::from_millis(10));
    }

    let measured = completed.expect("the mock loopback should complete");
    assert!(measured > 0.0 && measured < 100.0, "{measured}");
    stop_audio_engine().unwrap();
}
