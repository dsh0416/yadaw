use super::*;

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
    assert!(first.starts_with("heron.source."));
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

    let (events, transport) = sink.drain(true).unwrap();
    assert!(transport.is_empty());
    assert!(events.contains(&AraCallbackEvent::ContentChanged {
        object_kind: AraObjectKind::PlaybackRegion,
        object_id: "clip-41".into(),
        start_seconds: Some(2.0),
        duration_seconds: Some(6.0),
        scopes: 5,
    }));
    assert!(events.contains(&AraCallbackEvent::DocumentDataChanged));
    assert!(sink.drain(true).unwrap().0.is_empty());
}

#[test]
fn content_range_coalescing_keeps_the_available_interval() {
    assert_eq!(
        merge_content_ranges(None, Some((2.0, 3.0))),
        Some((2.0, 3.0))
    );
    assert_eq!(
        merge_content_ranges(Some((2.0, 3.0)), None),
        Some((2.0, 3.0))
    );
    assert_eq!(merge_content_ranges(None, None), None);
}

#[test]
fn transport_only_drain_preserves_aggregated_model_events() {
    let sink = AraCallbackSink::default();
    sink.activate();
    sink.register(CallbackObjectKind::PlaybackRegion, 41, "clip-41".into())
        .unwrap();
    sink.content_changed(CallbackObjectKind::PlaybackRegion, 41, None, 1)
        .unwrap();
    sink.transport(AraTransportRequest::Start).unwrap();

    let (events, transport) = sink.drain(false).unwrap();
    assert!(events.is_empty());
    assert_eq!(transport, vec![AraTransportRequest::Start]);
    assert!(
        sink.drain(true)
            .unwrap()
            .0
            .contains(&AraCallbackEvent::ContentChanged {
                object_kind: AraObjectKind::PlaybackRegion,
                object_id: "clip-41".into(),
                start_seconds: None,
                duration_seconds: None,
                scopes: 1,
            })
    );
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
        sink.drain(true).unwrap().1.len(),
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
    let (events, _) = sink.drain(true).unwrap();
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
        sink.drain(true).unwrap().1,
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
