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
