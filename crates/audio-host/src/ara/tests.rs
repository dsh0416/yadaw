use super::*;
use yadaw_dsp_runtime::protocol::{
    LiveMixerGraph, LivePluginInstance, LiveTempoEvent, LiveTimeSignatureEvent, PluginAudioMode,
};
use yadaw_vst3_host::{AudioLayout, HostProcessContext, HostedPlugin, PluginKind};

#[test]
fn planar_reads_zero_fill_outside_the_source() {
    let mut reader = AudioReader {
        frames: Arc::new(vec![[0.25, -0.5], [0.75, 1.0]]),
    };
    let mut left = [9.0; 4];
    let mut right = [9.0; 4];
    reader.read_f32(-1, &mut [&mut left, &mut right]).unwrap();
    assert_eq!(left, [0.0, 0.25, 0.75, 0.0]);
    assert_eq!(right, [0.0, -0.5, 1.0, 0.0]);
}

#[test]
fn persistent_ids_are_ascii_stable_and_namespaced() {
    let first = persistent_id("source", "C:/音频/take.wav");
    let second = persistent_id("source", "C:/音频/take.wav");
    assert_eq!(first, second);
    assert!(first.is_ascii());
    assert!(first.starts_with("yadaw.source."));
}

#[test]
fn callback_sink_coalesces_content_ranges_scopes_and_document_dirty() {
    let sink = AraCallbackSink::default();
    sink.activate();
    sink.register(CallbackObjectKind::PlaybackRegion, 41, "clip-41".into())
        .unwrap();
    sink.content_changed(
        CallbackObjectKind::PlaybackRegion,
        41,
        Some(ContentTimeRange::new(2.0, 3.0).unwrap()),
        1,
    )
    .unwrap();
    sink.content_changed(
        CallbackObjectKind::PlaybackRegion,
        41,
        Some(ContentTimeRange::new(4.0, 4.0).unwrap()),
        4,
    )
    .unwrap();
    sink.with_state(|state| {
        state.document_dirty = true;
        Ok(())
    })
    .unwrap();

    let (events, transport) = sink.drain().unwrap();
    assert!(transport.is_empty());
    assert!(events.contains(&AraCallbackEvent::ContentChanged {
        object_kind: AraObjectKind::PlaybackRegion,
        object_id: "clip-41".into(),
        start_seconds: Some(2.0),
        duration_seconds: Some(6.0),
        scopes: 5,
    }));
    assert!(events.contains(&AraCallbackEvent::DocumentDataChanged));
    assert!(sink.drain().unwrap().0.is_empty());
}

#[test]
fn transport_overflow_quarantines_only_that_callback_sink() {
    let sink = AraCallbackSink::default();
    sink.activate();
    for _ in 0..AraCallbackSink::TRANSPORT_CAPACITY {
        sink.transport(AraTransportRequest::Start).unwrap();
    }
    assert!(sink.transport(AraTransportRequest::Stop).is_err());
    assert_eq!(
        sink.quarantine_category(),
        Some(AraCallbackFailureCategory::QueueOverflow)
    );
    assert_eq!(
        sink.drain().unwrap().1.len(),
        AraCallbackSink::TRANSPORT_CAPACITY
    );
}

#[test]
fn archive_progress_keeps_only_the_latest_value_per_direction() {
    let sink = AraCallbackSink::default();
    sink.activate();
    sink.archive_progress(AraArchiveDirection::Store, 0.25)
        .unwrap();
    sink.archive_progress(AraArchiveDirection::Store, 0.75)
        .unwrap();
    sink.archive_progress(AraArchiveDirection::Restore, 0.5)
        .unwrap();
    let (events, _) = sink.drain().unwrap();
    assert!(events.contains(&AraCallbackEvent::ArchiveProgress {
        direction: AraArchiveDirection::Store,
        progress: 0.75,
    }));
    assert!(events.contains(&AraCallbackEvent::ArchiveProgress {
        direction: AraArchiveDirection::Restore,
        progress: 0.5,
    }));
}

#[test]
fn playback_provider_preserves_all_five_requests_in_order() {
    let sink = AraCallbackSink::default();
    sink.activate();
    let playback = PlaybackRequests {
        callbacks: sink.clone(),
    };
    ara2_bridge_host::PlaybackProvider::start(&playback).unwrap();
    ara2_bridge_host::PlaybackProvider::set_position(&playback, 1.25).unwrap();
    ara2_bridge_host::PlaybackProvider::set_cycle_range(&playback, 2.0, 3.0).unwrap();
    ara2_bridge_host::PlaybackProvider::enable_cycle(&playback, true).unwrap();
    ara2_bridge_host::PlaybackProvider::stop(&playback).unwrap();

    assert_eq!(
        sink.drain().unwrap().1,
        vec![
            AraTransportRequest::Start,
            AraTransportRequest::SetPosition(1.25),
            AraTransportRequest::SetCycleRange {
                start: 2.0,
                duration: 3.0,
            },
            AraTransportRequest::EnableCycle(true),
            AraTransportRequest::Stop,
        ]
    );
}

#[test]
#[ignore = "requires YADAW_ARA_TEST_PLUGIN to point at the official SDK fixture"]
fn official_vst3_fixture_binds_and_archives_an_ara_document() {
    let path = std::env::var_os("YADAW_ARA_TEST_PLUGIN")
        .expect("YADAW_ARA_TEST_PLUGIN must point at ARATestPlugIn.vst3");
    eprintln!("ARA fixture: discover classes");
    let discovery = Module::open(&path).unwrap();
    let classes = discovery.classes().unwrap();
    let audio_class = classes
        .iter()
        .find(|class| class.category == "Audio Module Class")
        .unwrap()
        .id;
    let factory_class = classes
        .iter()
        .find(|class| class.category == "ARA Main Factory Class")
        .unwrap()
        .id;
    let factory = AraFactoryHost::create(&discovery, factory_class).unwrap();

    eprintln!("ARA fixture: create VST3 component and bind document");
    let document_factory = Rc::clone(&factory);
    let (plugin, mut document) = HostedPlugin::create_with_layout_and_hook(
        &path,
        audio_class,
        48_000.0,
        PluginKind::Effect,
        AudioLayout::Stereo,
        move |_module, component| {
            AraDocument::create(
                "ara-fixture".into(),
                component,
                document_factory,
                Vec::new(),
            )
        },
    )
    .unwrap();
    let audio_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../third_party/vst3sdk/public.sdk/samples/vst/again_auv3/Shared/drumLoop.wav");
    let graph = LiveMixerGraph {
        sample_rate: 48_000,
        channels: Vec::new(),
        sends: Vec::new(),
        clips: vec![LiveMixerClip {
            id: "fixture-clip".into(),
            channel_id: "fixture-channel".into(),
            start_frame: 0,
            source_offset_frames: 0,
            length_frames: 4_800,
            fade_in_frames: 0,
            fade_out_frames: 0,
            path: audio_path.to_string_lossy().into_owned(),
        }],
        plugins: vec![LivePluginInstance {
            instance_id: "ara-fixture".into(),
            channel_id: "fixture-channel".into(),
            role: "insert".into(),
            slot_order: 0,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            latency_samples: 0,
            tail_samples: Some(0),
        }],
        midi_clips: Vec::new(),
        tempo_events: vec![LiveTempoEvent {
            tick: 0,
            beats_per_minute: 120.0,
        }],
        time_signature_events: vec![LiveTimeSignatureEvent {
            tick: 0,
            numerator: 4,
            denominator: 4,
        }],
    };
    document.sync_live_graph(Some(&graph)).unwrap();
    let mut processor = plugin.processor_lease();
    let mut input_left = [0.0; 256];
    let mut input_right = [0.0; 256];
    let mut output_left = [0.0; 256];
    let mut output_right = [0.0; 256];
    assert!(processor.process_block(
        &mut input_left,
        &mut input_right,
        &mut output_left,
        &mut output_right,
        &HostProcessContext {
            project_time_samples: 0,
            continuous_time_samples: 0,
            project_time_quarters: 0.0,
            bar_position_quarters: 0.0,
            tempo: 120.0,
            time_signature_numerator: 4,
            time_signature_denominator: 4,
            playing: true,
            recording: false,
        },
    ));
    eprintln!("ARA fixture: store archive");
    let archive = plugin
        .with_processing_paused(|| document.save_archive())
        .unwrap();
    assert!(!archive.is_empty());
    eprintln!("ARA fixture: drop document");
    drop(document);
    eprintln!("ARA fixture: drop component");
    drop(plugin);

    let restore_factory = Rc::clone(&factory);
    let (restored_plugin, mut restored_document) = HostedPlugin::create_with_layout_and_hook(
        &path,
        audio_class,
        48_000.0,
        PluginKind::Effect,
        AudioLayout::Stereo,
        move |_module, component| {
            AraDocument::create("ara-fixture".into(), component, restore_factory, archive)
        },
    )
    .unwrap();
    restored_document.sync_live_graph(Some(&graph)).unwrap();
    assert!(
        !restored_plugin
            .with_processing_paused(|| restored_document.save_archive())
            .unwrap()
            .is_empty()
    );
    drop(restored_document);
    drop(restored_plugin);
    drop(factory);
    drop(discovery);
    eprintln!("ARA fixture: complete");
}
