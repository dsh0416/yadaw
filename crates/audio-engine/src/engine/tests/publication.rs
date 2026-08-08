use super::*;

#[test]
fn audio_engine_identity_includes_the_requested_session_rate() {
    let base = AudioEngineKey {
        backend: "mock".to_owned(),
        input_device_id: "input".to_owned(),
        output_device_id: "output".to_owned(),
        requested_buffer_size: 128,
        requested_session_sample_rate: Some(44_100),
    };
    let same = base.clone();
    let changed = AudioEngineKey {
        requested_session_sample_rate: Some(96_000),
        ..base.clone()
    };
    assert_eq!(base, same);
    assert_ne!(base, changed);
}

#[test]
fn graph_publication_rejects_a_different_session_rate() {
    assert!(AudioEngine::validate_session_sample_rate(44_100, 44_100).is_ok());
    let error = AudioEngine::validate_session_sample_rate(44_100, 48_000).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("mixer sample rate does not match")
    );
}

#[test]
fn reclaiming_retired_graphs_without_a_running_engine_is_a_noop() {
    let _guard = GRAPH_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let engine = AudioEngine::new();
    assert_eq!(engine.reclaim_retired_graphs().expect("reclaim graphs"), 0);
}

#[test]
fn audition_commands_require_a_running_engine() {
    let engine = AudioEngine::new();

    assert!(engine.start_asset_audition("missing.bwf", [1, 2]).is_err());
    assert!(engine.stop_asset_audition().is_err());
}

#[test]
fn audition_preparation_validates_outputs_and_decodes_canonical_audio() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time moves forward")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "heron-audition-publication-{}-{nonce}.bwf",
        std::process::id()
    ));
    write_deterministic_test_recording(
        NativeRecordingStartConfig {
            path: path.to_string_lossy().into_owned(),
            asset_id: "audition-test".to_owned(),
            originator: "Heron test".to_owned(),
            origination_date: "2026-08-08".to_owned(),
            origination_time: "12:00:00".to_owned(),
            time_reference: 0,
            sample_rate: 48_000,
            channels: 2,
        },
        48_000,
        32,
    )
    .expect("write audition fixture");

    assert!(prepare_audition_command(&path.to_string_lossy(), 48_000, [0, 1]).is_err());
    assert!(
        prepare_audition_command(
            &path.to_string_lossy(),
            48_000,
            [1, MAX_OUTPUT_CHANNELS as u32 + 1]
        )
        .is_err()
    );
    let command = prepare_audition_command(&path.to_string_lossy(), 48_000, [1, 2])
        .expect("prepare audition");
    let EngineCommand::StartAudition(audition) = command else {
        panic!("expected start audition command");
    };
    assert_eq!(audition.hardware_outputs, [0, 1]);
    assert_eq!(audition.frames.len(), 32);

    fs::remove_file(path).expect("remove audition fixture");
}

#[test]
fn running_engine_accepts_and_processes_asset_audition_commands() {
    let _midi_guard = GLOBAL_MIDI_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _guard = GRAPH_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time moves forward")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "heron-running-audition-{}-{nonce}.bwf",
        std::process::id()
    ));
    write_deterministic_test_recording(
        NativeRecordingStartConfig {
            path: path.to_string_lossy().into_owned(),
            asset_id: "running-audition-test".to_owned(),
            originator: "Heron test".to_owned(),
            origination_date: "2026-08-08".to_owned(),
            origination_time: "12:00:00".to_owned(),
            time_reference: 0,
            sample_rate: 48_000,
            channels: 2,
        },
        48_000,
        64,
    )
    .expect("write audition fixture");
    let config = || NativeAudioEngineConfig {
        backend: "mock".to_owned(),
        input_device_id: "custom:mock-duplex".to_owned(),
        output_device_id: "custom:mock-duplex".to_owned(),
        buffer_size: 64,
        session_sample_rate: Some(48_000),
    };
    let engine = AudioEngine::new();

    let started = engine.start_audio_engine(config()).expect("start engine");
    assert_eq!(started.state, "running");
    assert_eq!(
        engine
            .start_audio_engine(config())
            .expect("reuse matching engine")
            .state,
        "running"
    );
    engine
        .start_asset_audition(&path.to_string_lossy(), [1, 2])
        .expect("queue audition start");
    thread::sleep(Duration::from_millis(10));
    engine.stop_asset_audition().expect("queue audition stop");
    thread::sleep(Duration::from_millis(10));
    assert_eq!(
        engine.stop_audio_engine().expect("stop engine").state,
        "stopped"
    );

    fs::remove_file(path).expect("remove audition fixture");
}

#[test]
fn begin_graph_build_allocates_monotonic_generations_without_a_running_engine() {
    let _guard = GRAPH_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let engine = AudioEngine::new();
    let first = engine
        .begin_graph_build(simple_native_graph())
        .expect("first build input");
    let second = engine
        .begin_graph_build(simple_native_graph())
        .expect("second build input");
    assert_eq!(first.build_generation() + 1, second.build_generation());
    assert_eq!(
        engine.latest_build_generation_for_test(),
        second.build_generation()
    );
}

#[test]
fn stale_compiled_builds_are_superseded_before_publication() {
    let _guard = GRAPH_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let engine = AudioEngine::new();
    let stale = engine
        .begin_graph_build(simple_native_graph())
        .expect("stale build input");
    let _fresh = engine
        .begin_graph_build(simple_native_graph())
        .expect("fresh build input");
    let built = compile_graph_build(stale).expect("compile stale build");
    let outcome = engine
        .publish_mixer_runtime(built)
        .expect("publish stale build");
    assert_eq!(outcome, PublishOutcome::Superseded);
    assert!(engine.compiled_audio_graph_snapshot().is_none());
}

#[test]
fn publication_generation_never_moves_backward_after_a_newer_build_is_published() {
    let _guard = GRAPH_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let engine = AudioEngine::new();
    let stale = engine
        .begin_graph_build(simple_native_graph())
        .expect("stale build input");
    let fresh = engine
        .begin_graph_build(simple_native_graph())
        .expect("fresh build input");
    let stale_generation = stale.build_generation();
    let fresh_generation = fresh.build_generation();

    assert_eq!(
        engine
            .publish_mixer_runtime(compile_graph_build(fresh).expect("compile fresh build"))
            .expect("publish fresh build"),
        PublishOutcome::Published
    );
    assert_eq!(
        engine
            .publish_mixer_runtime(compile_graph_build(stale).expect("compile stale build"))
            .expect("reject stale build"),
        PublishOutcome::Superseded
    );
    assert!(fresh_generation > stale_generation);
    assert_eq!(engine.latest_build_generation_for_test(), fresh_generation);
}

#[test]
fn same_revision_rebuild_preserves_a_newer_plugin_bypass_preview() {
    let _guard = GRAPH_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let engine = AudioEngine::new();
    let mut stale_graph = simple_native_graph();
    stale_graph.plugins.push(NativePluginInstance {
        instance_id: "fx".to_owned(),
        channel_index: 0,
        role: "insert".to_owned(),
        slot_order: 0,
        audio_mode: PluginAudioMode::Stereo,
        enabled: true,
        aux_input_buses: Vec::new(),
        latency_samples: 0,
        tail_samples: Some(0),
        processor: None,
    });
    engine
        .load_mixer_graph(stale_graph.clone())
        .expect("publish initial graph");
    engine
        .preview_mixer_parameter(NativeMixerParameterPreview {
            target: "plugin".to_owned(),
            id: "fx".to_owned(),
            parameter: "enabled".to_owned(),
            value: 0.0,
        })
        .expect("preview bypass");

    let stale_build = engine
        .begin_graph_build(stale_graph)
        .and_then(compile_graph_build)
        .expect("compile stale same-revision graph");
    assert_eq!(
        engine
            .publish_mixer_runtime(stale_build)
            .expect("publish same-revision graph"),
        PublishOutcome::Published
    );

    let pending = engine.pending_mixer.lock().expect("pending mixer lock");
    assert!(!pending.as_ref().expect("pending mixer").plugins_by_channel[0][0].enabled);
    drop(pending);
    let graph = engine.last_native_graph.lock().expect("last graph lock");
    assert!(!graph.as_ref().expect("last graph").plugins[0].enabled);
}

#[test]
fn apply_plugin_timing_returns_replacement_only_when_values_change() {
    let _guard = GRAPH_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let engine = AudioEngine::new();
    engine.set_last_native_graph_for_test(Some(NativeMixerGraph {
        generation: 1,
        sample_rate: 48_000,
        project_end_tick: 61_440,
        latency_policy: NativeLatencyPolicy::Normal,
        channels: Vec::new(),
        sends: Vec::new(),
        clips: Vec::new(),
        plugins: vec![NativePluginInstance {
            instance_id: "session-fx".to_owned(),
            channel_index: 0,
            role: "insert".to_owned(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: Vec::new(),
            latency_samples: 0,
            tail_samples: Some(0),
            processor: None,
        }],
        midi_clips: Vec::new(),
        tempo_events: Vec::new(),
        time_signature_events: Vec::new(),
    }));
    assert!(
        engine
            .apply_plugin_timing("missing", 8, Some(16))
            .expect("missing plugin")
            .is_none()
    );
    assert!(
        engine
            .apply_plugin_timing("session-fx", 0, Some(0))
            .expect("unchanged timing")
            .is_none()
    );
    let replacement = engine
        .apply_plugin_timing("session-fx", 32, Some(64))
        .expect("changed timing")
        .expect("replacement graph");
    assert_eq!(replacement.plugins[0].latency_samples, 32);
    assert_eq!(replacement.plugins[0].tail_samples, Some(64));
    engine.set_last_native_graph_for_test(None);
}
