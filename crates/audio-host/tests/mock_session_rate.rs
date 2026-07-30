use std::{
    thread,
    time::{Duration, Instant},
};

use yadaw_audio_host::engine::{
    NativeAudioEngineConfig, NativeMixerChannel, NativeMixerGraph, NativeTransportSnapshot,
    begin_graph_build, compile_graph_build, heartbeat_snapshot, publish_mixer_runtime,
    start_audio_engine, stop_audio_engine, transport_command, transport_snapshot,
};
use yadaw_audio_host::mock;
use yadaw_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};

const MOCK_BLOCK_FRAMES: u64 = 128;
const NATIVE_SAMPLE_RATE: u64 = 48_000;
const PROJECT_SAMPLE_RATE: u64 = 44_100;
const CALLBACKS_TO_OBSERVE: u64 = 128;
const MAX_CLOCK_RATE_ERROR_PERCENT: u64 = 2;

fn stable_transport_snapshot() -> (u64, NativeTransportSnapshot) {
    loop {
        let (generation_before, _) = heartbeat_snapshot();
        let transport = transport_snapshot().unwrap();
        let (generation_after, _) = heartbeat_snapshot();
        if generation_before == generation_after {
            return (generation_after, transport);
        }
        thread::yield_now();
    }
}

#[test]
fn mock_backend_uses_the_project_clock_over_native_48_khz_io() {
    let runtime = start_audio_engine(NativeAudioEngineConfig {
        backend: mock::BACKEND_ID.to_owned(),
        input_device_id: "custom:mock-input".to_owned(),
        output_device_id: "custom:mock-output".to_owned(),
        buffer_size: 128,
        session_sample_rate: Some(44_100),
    })
    .unwrap();
    assert_eq!(runtime.sample_rate, Some(44_100));
    assert_eq!(runtime.input_sample_rate, Some(48_000));
    assert_eq!(runtime.output_sample_rate, Some(48_000));

    let graph = NativeMixerGraph {
        generation: 1,
        sample_rate: 44_100,
        channels: vec![
            NativeMixerChannel {
                id: "master".to_owned(),
                kind: "master".to_owned(),
                system_role: None,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output_index: None,
                output_bus: None,
                record_armed: false,
                input_monitoring: false,
                input_source: None,
                input_channels: vec![],
                hardware_output_channels: vec![],
                midi_input_port_id: None,
                midi_input_channel: None,
            },
            NativeMixerChannel {
                id: "output".to_owned(),
                kind: "output".to_owned(),
                system_role: None,
                gain_db: 0.0,
                pan: 0.0,
                muted: false,
                soloed: false,
                output_index: None,
                output_bus: None,
                record_armed: false,
                input_monitoring: false,
                input_source: None,
                input_channels: vec![],
                hardware_output_channels: vec![1, 2],
                midi_input_port_id: None,
                midi_input_channel: None,
            },
        ],
        sends: vec![],
        clips: vec![],
        plugins: vec![],
        midi_clips: vec![],
        tempo_events: vec![TempoEvent {
            tick: 0,
            beats_per_minute: 120.0,
        }],
        time_signature_events: vec![TimeSignatureEvent {
            tick: 0,
            numerator: 4,
            denominator: 4,
        }],
    };
    let built = compile_graph_build(begin_graph_build(graph).unwrap()).unwrap();
    publish_mixer_runtime(built).unwrap();
    transport_command("play".to_owned(), None).unwrap();

    let start_deadline = Instant::now() + Duration::from_secs(5);
    let (start_generation, start_position) = loop {
        let (generation, transport) = stable_transport_snapshot();
        if transport.state == "playing" && transport.position_frames > 0 {
            break (generation, transport.position_frames);
        }
        assert!(
            Instant::now() < start_deadline,
            "mock transport did not start before the timeout"
        );
        thread::sleep(Duration::from_millis(1));
    };
    let target_generation = start_generation.saturating_add(CALLBACKS_TO_OBSERVE);

    let callback_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (generation, _) = heartbeat_snapshot();
        if generation >= target_generation {
            break;
        }
        assert!(
            Instant::now() < callback_deadline,
            "mock audio callbacks did not advance before the timeout"
        );
        thread::sleep(Duration::from_millis(1));
    }
    let (end_generation, transport) = stable_transport_snapshot();

    let callback_count = end_generation.saturating_sub(start_generation);
    let expected_project_frames = callback_count
        .saturating_mul(MOCK_BLOCK_FRAMES)
        .saturating_mul(PROJECT_SAMPLE_RATE)
        / NATIVE_SAMPLE_RATE;
    // Project frames are rendered in resampler refill batches rather than one
    // at a time. A transport snapshot can therefore be ahead of or behind the
    // callback count by one batch. Over this observation window a batch is
    // less than 2%, while a native 48 kHz clock would be about 8.8% too fast.
    let max_project_frame_error =
        expected_project_frames.saturating_mul(MAX_CLOCK_RATE_ERROR_PERCENT) / 100;
    let advanced_project_frames =
        u64::try_from(transport.position_frames.saturating_sub(start_position)).unwrap();

    assert_eq!(transport.sample_rate, PROJECT_SAMPLE_RATE as u32);
    assert_eq!(transport.state, "playing");
    assert!(
        advanced_project_frames.abs_diff(expected_project_frames) <= max_project_frame_error,
        "mock transport advanced {advanced_project_frames} project frames over \
         {callback_count} native callbacks; expected {expected_project_frames} within \
         {MAX_CLOCK_RATE_ERROR_PERCENT}% ({max_project_frame_error} frames)"
    );
    stop_audio_engine().unwrap();
}
