use std::{thread, time::Duration};

use yadaw_audio_host::engine::{
    NativeAudioEngineConfig, NativeMixerChannel, NativeMixerGraph, begin_graph_build,
    compile_graph_build, publish_mixer_runtime, start_audio_engine, stop_audio_engine,
    transport_command, transport_snapshot,
};
use yadaw_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};

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
    thread::sleep(Duration::from_millis(120));

    let transport = transport_snapshot().unwrap();
    assert_eq!(transport.sample_rate, 44_100);
    assert_eq!(transport.state, "playing");
    assert!(
        (500..=8_000).contains(&transport.position_frames),
        "virtual transport advanced {} project frames",
        transport.position_frames
    );
    stop_audio_engine().unwrap();
}
