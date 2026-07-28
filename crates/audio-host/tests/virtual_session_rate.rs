use std::{
    thread,
    time::{Duration, Instant},
};

use yadaw_audio_host::engine::{
    NativeAudioEngineConfig, NativeMixerChannel, NativeMixerGraph, begin_graph_build,
    compile_graph_build, heartbeat_snapshot, publish_mixer_runtime, start_audio_engine,
    stop_audio_engine, transport_command, transport_snapshot,
};
use yadaw_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};

const VIRTUAL_BLOCK_FRAMES: u64 = 128;
const NATIVE_SAMPLE_RATE: u64 = 48_000;
const PROJECT_SAMPLE_RATE: u64 = 44_100;
const CALLBACKS_TO_OBSERVE: u64 = 64;

#[test]
fn virtual_backend_uses_the_project_clock_over_native_48_khz_io() {
    // SAFETY: This integration test is its own process and sets the opt-in
    // before the virtual audio worker or any other thread is spawned.
    unsafe {
        std::env::set_var("YADAW_TEST_VIRTUAL_AUDIO", "1");
    }
    let runtime = start_audio_engine(NativeAudioEngineConfig {
        backend: "virtual".to_owned(),
        input_device_id: "virtual-input".to_owned(),
        output_device_id: "virtual-output".to_owned(),
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

    let deadline = Instant::now() + Duration::from_secs(5);
    let (start_generation, start_position) = loop {
        let (generation, state) = heartbeat_snapshot();
        let transport = transport_snapshot().unwrap();
        if state == "playing" && transport.position_frames > 0 {
            break (generation, transport.position_frames);
        }
        assert!(
            Instant::now() < deadline,
            "virtual transport did not start before the timeout"
        );
        thread::sleep(Duration::from_millis(1));
    };
    let target_generation = start_generation.saturating_add(CALLBACKS_TO_OBSERVE);

    let (end_generation, transport) = loop {
        let (generation, _) = heartbeat_snapshot();
        let transport = transport_snapshot().unwrap();
        if generation >= target_generation {
            break (generation, transport);
        }
        assert!(
            Instant::now() < deadline,
            "virtual audio callbacks did not advance before the timeout"
        );
        thread::sleep(Duration::from_millis(1));
    };

    let callback_count = end_generation.saturating_sub(start_generation);
    let expected_project_frames = callback_count
        .saturating_mul(VIRTUAL_BLOCK_FRAMES)
        .saturating_mul(PROJECT_SAMPLE_RATE)
        / NATIVE_SAMPLE_RATE;
    let advanced_project_frames =
        u64::try_from(transport.position_frames.saturating_sub(start_position)).unwrap();

    assert_eq!(transport.sample_rate, PROJECT_SAMPLE_RATE as u32);
    assert_eq!(transport.state, "playing");
    assert!(
        advanced_project_frames.abs_diff(expected_project_frames) <= VIRTUAL_BLOCK_FRAMES,
        "virtual transport advanced {advanced_project_frames} project frames over \
         {callback_count} native callbacks; expected about {expected_project_frames}"
    );
    stop_audio_engine().unwrap();
}
