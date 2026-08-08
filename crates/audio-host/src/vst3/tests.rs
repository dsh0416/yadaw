use super::*;
use heron_dsp_runtime::protocol::{PluginLocator, PluginStateChunk, PluginStateEnvelope};

#[test]
fn invalid_preferences_are_rejected_before_window_creation() {
    let runtime = Vst3Runtime::new();
    let result = runtime.editor_result(
        "missing",
        PluginEditorPreference {
            mode: heron_dsp_runtime::protocol::PluginEditorMode::Native,
            zoom_percent: 401,
        },
    );
    assert!(matches!(result, ControlResult::Error { .. }));
}

#[test]
fn unload_of_a_missing_instance_is_accepted_without_retirement() {
    let mut runtime = Vst3Runtime::new();
    assert!(matches!(
        runtime.unload_plugin("missing"),
        ControlResult::Accepted
    ));
    assert!(matches!(
        runtime.unload_plugin("missing"),
        ControlResult::Accepted
    ));
    assert_eq!(runtime.retired_instance_count(), 0);
}

#[test]
fn only_reserved_instance_ids_use_benchmark_lifetime_reuse() {
    assert!(is_audio_benchmark_instance(
        "__heron-audio-benchmark-gain-63"
    ));
    assert!(!is_audio_benchmark_instance("project-plugin"));
}

#[test]
fn an_infinite_dual_mono_tail_dominates_a_finite_tail() {
    assert_eq!(max_tail(Some(128), None), None);
    assert_eq!(max_tail(Some(128), Some(256)), Some(256));
}

#[test]
fn dual_mono_host_requests_are_forwarded_once_across_lanes() {
    let duplicated = Vst3HostRequest::DirtyChanged(true);
    let primary_only = Vst3HostRequest::GroupEditStarted;
    let secondary_only = Vst3HostRequest::OpenEditor {
        view_name: "editor".to_owned(),
    };

    let merged = merge_dual_mono_host_requests(
        vec![duplicated.clone(), primary_only.clone()],
        vec![duplicated, secondary_only.clone()],
    );

    assert_eq!(
        merged,
        vec![
            Vst3HostRequest::DirtyChanged(true),
            primary_only,
            secondary_only
        ]
    );
}

#[test]
fn host_request_merge_preserves_repeated_requests_from_one_lane() {
    let repeated = Vst3HostRequest::GroupEditFinished;
    assert_eq!(
        merge_dual_mono_host_requests(Vec::new(), vec![repeated.clone(), repeated.clone()]),
        vec![repeated.clone(), repeated.clone()]
    );
    assert_eq!(
        merge_dual_mono_host_requests(vec![repeated.clone(), repeated.clone()], Vec::new()),
        vec![repeated.clone(), repeated]
    );
}

#[test]
fn pending_dirty_requests_are_coalesced_per_instance() {
    let mut pending = VecDeque::new();
    push_pending_host_request(
        &mut pending,
        "first".to_owned(),
        Vst3HostRequest::DirtyChanged(true),
    );
    push_pending_host_request(
        &mut pending,
        "first".to_owned(),
        Vst3HostRequest::DirtyChanged(true),
    );
    push_pending_host_request(
        &mut pending,
        "second".to_owned(),
        Vst3HostRequest::DirtyChanged(true),
    );
    push_pending_host_request(
        &mut pending,
        "first".to_owned(),
        Vst3HostRequest::GroupEditStarted,
    );

    assert_eq!(
        pending,
        VecDeque::from([
            ("first".to_owned(), Vst3HostRequest::DirtyChanged(true)),
            ("second".to_owned(), Vst3HostRequest::DirtyChanged(true)),
            ("first".to_owned(), Vst3HostRequest::GroupEditStarted),
        ])
    );
}

#[test]
fn ara_dual_mono_is_a_plugin_capability_error() {
    let mut runtime = Vst3Runtime::new();
    let result = runtime.load_plugin(LoadPluginRequest {
        instance_id: "ara-dual-mono".into(),
        module_path: "unused.vst3".into(),
        class_id: "00000000000000000000000000000000".into(),
        plugin_kind: "effect".into(),
        audio_mode: PluginAudioMode::DualMono,
        active_aux_inputs: Vec::new(),
        sample_rate: 48_000.0,
        component_state: Vec::new(),
        controller_state: Vec::new(),
        ara_factory_class_id: Some("00000000000000000000000000000001".into()),
        ara_document_state: Vec::new(),
    });
    let ControlResult::Error { error } = result else {
        panic!("ARA dual-mono must be rejected before module loading");
    };
    assert_eq!(
        error.code,
        heron_dsp_runtime::protocol::RpcErrorCode::ValidationFailed
    );
    assert_eq!(error.retry, heron_dsp_runtime::protocol::RpcRetry::Never);
    assert_eq!(error.user_message_key, "errors.pluginUnavailable");
}

#[test]
fn empty_runtime_queries_and_graph_lifecycle_are_deterministic() {
    let mut runtime = Vst3Runtime::new();
    let graph = LiveMixerGraph {
        sample_rate: 48_000,
        project_end_tick: 0,
        latency_policy: Default::default(),
        channels: Vec::new(),
        sends: Vec::new(),
        clips: Vec::new(),
        plugins: Vec::new(),
        midi_clips: Vec::new(),
        tempo_events: Vec::new(),
        time_signature_events: Vec::new(),
    };

    assert!(runtime.processor_handle("missing").is_none());
    assert!(runtime.processor_handles().is_empty());
    assert!(runtime.graph_processor_handles("missing").is_empty());
    assert_eq!(runtime.display_name("missing"), None);
    assert_eq!(runtime.class_id("missing"), None);
    assert!(runtime.parameters("missing").is_err());
    assert!(runtime.format_parameter_value("missing", 1, 0.5).is_err());
    assert!(runtime.create_view("missing").is_err());
    assert!(runtime.editor_state("missing").is_err());
    assert!(
        runtime
            .restore_editor_state(
                "missing",
                &EditorPluginState {
                    component_state: Vec::new(),
                    controller_state: Vec::new(),
                },
            )
            .is_err()
    );
    assert!(!runtime.has_ara_documents());
    assert!(runtime.poll_ara_callbacks(true).is_empty());
    assert!(runtime.flush_output_parameters().is_ok());
    assert!(runtime.sync_ara_graph(Some(&graph)).is_ok());
    assert!(
        runtime
            .sync_presentation_latencies(Some(&graph), 3, 4)
            .is_ok()
    );

    runtime
        .prepare_graph_instances("operation", &graph)
        .unwrap();
    assert_eq!(
        runtime.activate_graph_instances("operation").unwrap(),
        Vec::<String>::new()
    );
    runtime.finish_graph_instances("operation");
    assert!(runtime.rollback_graph_instances("operation").is_empty());
    runtime.abort_graph_instances("operation");
    assert!(runtime.activate_graph_instances("missing").is_err());
    assert_eq!(runtime.reclaim_retired_instances(), 0);
    assert!(!runtime.has_retired_instances());
}

#[test]
fn empty_runtime_rejects_stale_editor_parameter_and_state_requests() {
    let mut runtime = Vst3Runtime::new();
    runtime.mark_editor_state_dirty("missing");
    assert!(runtime.take_host_requests().is_empty());
    assert!(runtime.take_timing_changes().is_empty());
    assert!(runtime.take_editor_parameter_gestures().is_empty());
    assert!(runtime.take_restart_failures().is_empty());
    assert!(
        runtime
            .set_parameter_from_editor("missing", 1, 0.5, ParameterGesture::Perform,)
            .is_err()
    );
    assert!(matches!(
        runtime.apply_parameter_command(ParameterCommand {
            session_epoch: 1,
            sequence: 1,
            target_kind: heron_dsp_runtime::protocol::ParameterTargetKind::Plugin,
            runtime_handle: 77,
            parameter_token: 0,
            target_generation: 1,
            value: 0.5,
            gesture: ParameterGesture::Perform,
        }),
        ControlResult::Error { .. }
    ));
}

#[test]
fn execute_rejects_invalid_load_and_parameter_envelopes_before_native_loading() {
    let mut runtime = Vst3Runtime::new();
    let load = |locator, state| ControlCommand::LoadPlugin {
        instance_id: "test".to_owned(),
        locator,
        plugin_kind: "effect".to_owned(),
        audio_mode: PluginAudioMode::Stereo,
        active_aux_inputs: Vec::new(),
        sample_rate: 48_000.0,
        state,
        ara_factory_class_id: None,
    };
    let locator = PluginLocator {
        format: heron_dsp_runtime::protocol::PluginFormat::Vst3,
        artifact_path: "/missing.vst3".to_owned(),
        native_id: "not-a-class-id".to_owned(),
    };

    let cases = [
        load(
            PluginLocator {
                format: heron_dsp_runtime::protocol::PluginFormat::Clap,
                ..locator.clone()
            },
            PluginStateEnvelope {
                version: 1,
                chunks: Vec::new(),
            },
        ),
        load(
            locator.clone(),
            PluginStateEnvelope {
                version: 1,
                chunks: vec![PluginStateChunk {
                    key: "component".to_owned(),
                    bytes: BinaryPayload::Shared {
                        reference: heron_dsp_runtime::protocol::SharedBlobRef {
                            session_epoch: 1,
                            region_id: 1,
                            region_generation: 1,
                            slot: 1,
                            allocation_generation: 1,
                            offset: 0,
                            length: 1,
                            lease_id: 1,
                        },
                    },
                }],
            },
        ),
        load(
            locator,
            PluginStateEnvelope {
                version: 1,
                chunks: Vec::new(),
            },
        ),
        ControlCommand::PluginParameters {
            instance_id: "missing".to_owned(),
        },
        ControlCommand::SavePluginState {
            instance_id: "missing".to_owned(),
        },
        ControlCommand::SetPluginParameter {
            instance_id: "missing".to_owned(),
            parameter_key: "clap:1".to_owned(),
            value: 0.5,
            gesture: ParameterGesture::Perform,
        },
    ];
    for command in cases {
        assert!(matches!(
            runtime.execute(command),
            ControlResult::Error { .. }
        ));
    }
}

#[test]
fn helper_mappings_cover_payloads_ports_tails_and_bounded_queues() {
    assert_eq!(vst3_input_index("vst3:audio:input:0"), Some(0));
    assert_eq!(vst3_input_index("vst3:audio:input:42"), Some(42));
    assert_eq!(vst3_input_index("vst3:audio:output:0"), None);
    assert_eq!(vst3_input_index("vst3:audio:input:nope"), None);
    assert_eq!(
        inline_bytes(BinaryPayload::inline(vec![1, 2])),
        Ok(vec![1, 2])
    );
    assert_eq!(max_tail(None, Some(1)), None);
    assert_eq!(max_tail(None, None), None);

    let mut pending = VecDeque::new();
    for index in 0..=HOST_REQUEST_CAPACITY {
        push_pending_host_request(
            &mut pending,
            format!("plugin-{index}"),
            Vst3HostRequest::GroupEditStarted,
        );
    }
    assert_eq!(pending.len(), HOST_REQUEST_CAPACITY);
    assert_eq!(
        pending.front().map(|entry| entry.0.as_str()),
        Some("plugin-1")
    );
}
