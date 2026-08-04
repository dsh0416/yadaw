use super::*;
use heron_dsp_runtime::protocol::{
    ControlCommand, ControlRequest, GraphUpdate, LiveLatencyPolicy, LiveMidiClip, LiveMidiEvent,
    LiveMidiNote, LiveMixerGraph, LiveTempoEvent, LiveTimeSignatureEvent, MidiEventBatch,
    MidiNoteBatch, RecordingWaveform,
};

#[test]
fn payload_at_threshold_stays_inline_and_larger_payload_uses_shared_memory() {
    let request = |size| ControlRequest {
        request_id: size as u64,
        command: ControlCommand::LoadPlugin {
            instance_id: "plugin".into(),
            module_path: "fixture.vst3".into(),
            class_id: "fixture".into(),
            plugin_kind: "effect".into(),
            audio_mode: heron_dsp_runtime::protocol::PluginAudioMode::Stereo,
            active_aux_inputs: Vec::new(),
            sample_rate: 48_000.0,
            component_state: BinaryPayload::inline(vec![7; size]),
            controller_state: BinaryPayload::inline(Vec::new()),
            ara_factory_class_id: None,
            ara_document_state: BinaryPayload::inline(Vec::new()),
        },
    };
    let mut leases = LeaseRegistry::new();
    let inline = encode_request(request(INLINE_BLOB_LIMIT), &mut leases).unwrap();
    assert!(inline.region_offers.is_empty());
    let shared = encode_request(request(INLINE_BLOB_LIMIT + 1), &mut leases).unwrap();
    assert_eq!(shared.region_offers.len(), 1);
    let mut receiver = ArenaReceiver::new(1);
    let (decoded, release) = decode_request(shared, &mut receiver).unwrap();
    assert_eq!(release.len(), 1);
    let ControlCommand::LoadPlugin {
        component_state, ..
    } = decoded.command
    else {
        panic!("wrong command");
    };
    assert_eq!(
        component_state.as_inline().map(<[u8]>::len),
        Some(INLINE_BLOB_LIMIT + 1)
    );
}

#[test]
fn benchmark_echo_uses_the_same_shared_memory_path_in_both_directions() {
    let payload = vec![0xa5; INLINE_BLOB_LIMIT + 1];
    let request = ControlRequest {
        request_id: 42,
        command: ControlCommand::BenchmarkEcho {
            payload: BinaryPayload::inline(payload.clone()),
        },
    };
    let mut request_leases = LeaseRegistry::new();
    let request_packet = encode_request(request, &mut request_leases).unwrap();
    assert_eq!(request_packet.region_offers.len(), 1);
    let mut request_receiver = ArenaReceiver::new(1);
    let (decoded, release) =
        decode_request_deferred(request_packet, &mut request_receiver).unwrap();
    assert_eq!(release.len(), 1);
    let ControlCommand::BenchmarkEcho {
        payload: decoded_payload,
    } = decoded.command
    else {
        panic!("wrong benchmark command");
    };
    let BinaryPayload::Shared { reference } = decoded_payload else {
        panic!("deferred benchmark payload was materialized");
    };
    assert_eq!(request_receiver.resolve(reference).unwrap(), payload);

    let response = ControlResponse {
        request_id: 42,
        result: ControlResult::BenchmarkEcho {
            payload: BinaryPayload::Shared { reference },
        },
    };
    let mut response_leases = LeaseRegistry::new();
    let response_packet =
        encode_response_from_arena(response, &mut response_leases, &request_receiver).unwrap();
    assert_eq!(response_packet.region_offers.len(), 1);
    let mut response_receiver = ArenaReceiver::new(1);
    let (decoded, release) = decode_response(response_packet, &mut response_receiver).unwrap();
    assert_eq!(release.len(), 1);
    let ControlResult::BenchmarkEcho {
        payload: decoded_payload,
    } = decoded.result
    else {
        panic!("wrong benchmark result");
    };
    assert_eq!(decoded_payload.as_inline(), Some(payload.as_slice()));
}

#[test]
fn multiple_large_fields_share_one_aligned_persistent_region() {
    let request = ControlRequest {
        request_id: 4,
        command: ControlCommand::LoadPlugin {
            instance_id: "plugin".into(),
            module_path: "fixture.vst3".into(),
            class_id: "fixture".into(),
            plugin_kind: "effect".into(),
            audio_mode: heron_dsp_runtime::protocol::PluginAudioMode::Stereo,
            active_aux_inputs: Vec::new(),
            sample_rate: 48_000.0,
            component_state: BinaryPayload::inline(vec![1; INLINE_BLOB_LIMIT + 3]),
            controller_state: BinaryPayload::inline(vec![2; INLINE_BLOB_LIMIT + 5]),
            ara_factory_class_id: Some("ARA factory".into()),
            ara_document_state: BinaryPayload::inline(vec![3; INLINE_BLOB_LIMIT + 7]),
        },
    };
    let mut leases = LeaseRegistry::new();
    let packet = encode_request(request, &mut leases).unwrap();
    assert_eq!(packet.region_offers.len(), 1);
    let wire = decode_body::<ControlRequest>(&packet.body).unwrap();
    let ControlCommand::LoadPlugin {
        component_state: BinaryPayload::Shared {
            reference: component,
        },
        controller_state: BinaryPayload::Shared {
            reference: controller,
        },
        ara_document_state: BinaryPayload::Shared {
            reference: ara_document,
        },
        ..
    } = wire.command
    else {
        panic!("large plugin states were not externalized");
    };
    assert_eq!(component.region_id, controller.region_id);
    assert_eq!(component.region_id, ara_document.region_id);
    assert_eq!(component.offset % 8, 0);
    assert_eq!(controller.offset % 8, 0);
    assert_eq!(ara_document.offset % 8, 0);
    assert_ne!(component.lease_id, controller.lease_id);
    assert_ne!(controller.lease_id, ara_document.lease_id);
    let mut receiver = ArenaReceiver::new(1);
    let (decoded, release) = decode_request(packet, &mut receiver).unwrap();
    assert_eq!(release.len(), 3);
    let ControlCommand::LoadPlugin {
        component_state,
        controller_state,
        ara_document_state,
        ..
    } = decoded.command
    else {
        panic!("wrong decoded command");
    };
    assert_eq!(component_state.as_inline().unwrap()[0], 1);
    assert_eq!(controller_state.as_inline().unwrap()[0], 2);
    assert_eq!(ara_document_state.as_inline().unwrap()[0], 3);
}

#[test]
fn large_midi_sysex_batch_uses_and_restores_a_shared_attachment() {
    let request = ControlRequest {
        request_id: 5,
        command: ControlCommand::UpdateGraph {
            update: GraphUpdate::Replace {
                revision: 1,
                graph: LiveMixerGraph {
                    sample_rate: 48_000,
                    project_end_tick: 61_440,
                    latency_policy: LiveLatencyPolicy::Normal,
                    channels: Vec::new(),
                    sends: Vec::new(),
                    clips: Vec::new(),
                    plugins: Vec::new(),
                    midi_clips: vec![LiveMidiClip {
                        id: "midi".into(),
                        channel_id: "instrument".into(),
                        start_tick: 0,
                        source_offset_ticks: 0,
                        length_ticks: 960,
                        notes: MidiNoteBatch::Inline { notes: Vec::new() },
                        events: MidiEventBatch::Inline {
                            events: vec![LiveMidiEvent {
                                tick: 0,
                                channel: None,
                                kind: "sysex".into(),
                                data: BinaryPayload::inline(vec![0x7d; INLINE_BLOB_LIMIT + 1]),
                            }],
                        },
                    }],
                    tempo_events: vec![LiveTempoEvent {
                        tick: 0,
                        beats_per_minute: 120.0,
                    }],
                    time_signature_events: vec![LiveTimeSignatureEvent {
                        tick: 0,
                        numerator: 4,
                        denominator: 4,
                    }],
                },
            },
        },
    };
    let mut leases = LeaseRegistry::new();
    let packet = encode_request(request, &mut leases).unwrap();
    assert_eq!(packet.region_offers.len(), 1);
    let mut receiver = ArenaReceiver::new(1);
    let (decoded, release) = decode_request(packet, &mut receiver).unwrap();
    assert_eq!(release.len(), 1);
    let ControlCommand::UpdateGraph {
        update: GraphUpdate::Replace { graph, .. },
    } = decoded.command
    else {
        panic!("wrong graph command");
    };
    let MidiEventBatch::Inline { events } = &graph.midi_clips[0].events else {
        panic!("MIDI events were not materialized");
    };
    assert_eq!(
        events[0].data.as_inline().map(<[u8]>::len),
        Some(INLINE_BLOB_LIMIT + 1)
    );
}

#[test]
fn large_midi_notes_use_a_borrowed_fixed_layout_before_snapshot_materialization() {
    let notes = (0_u64..4_096)
        .map(|index| LiveMidiNote {
            start_tick: index * 120,
            duration_ticks: 96,
            channel: u8::try_from(index % 16).unwrap(),
            key: u8::try_from(36 + index % 48).unwrap(),
            velocity: 100,
            release_velocity: 64,
        })
        .collect::<Vec<_>>();
    let request = ControlRequest {
        request_id: 6,
        command: ControlCommand::UpdateGraph {
            update: GraphUpdate::Replace {
                revision: 2,
                graph: LiveMixerGraph {
                    sample_rate: 48_000,
                    project_end_tick: 61_440,
                    latency_policy: LiveLatencyPolicy::Normal,
                    channels: Vec::new(),
                    sends: Vec::new(),
                    clips: Vec::new(),
                    plugins: Vec::new(),
                    midi_clips: vec![LiveMidiClip {
                        id: "midi".into(),
                        channel_id: "instrument".into(),
                        start_tick: 0,
                        source_offset_ticks: 0,
                        length_ticks: 960,
                        notes: MidiNoteBatch::Inline {
                            notes: notes.clone(),
                        },
                        events: MidiEventBatch::Inline { events: Vec::new() },
                    }],
                    tempo_events: vec![LiveTempoEvent {
                        tick: 0,
                        beats_per_minute: 120.0,
                    }],
                    time_signature_events: vec![LiveTimeSignatureEvent {
                        tick: 0,
                        numerator: 4,
                        denominator: 4,
                    }],
                },
            },
        },
    };
    let mut leases = LeaseRegistry::new();
    let packet = encode_request(request, &mut leases).unwrap();
    assert_eq!(packet.region_offers.len(), 1);
    assert!(packet.body.len() < 8 * 1024);

    let mut receiver = ArenaReceiver::new(1);
    let (mut decoded, release) = decode_request_deferred(packet, &mut receiver).unwrap();
    assert_eq!(release.len(), 1);
    let ControlCommand::UpdateGraph {
        update: GraphUpdate::Replace { graph, .. },
    } = &mut decoded.command
    else {
        panic!("wrong graph command");
    };
    let view = resolve_midi_note_batch(&graph.midi_clips[0].notes, &receiver).unwrap();
    let MidiNoteBatchView::Shared(wire_notes) = view else {
        panic!("large MIDI note batch was not borrowed from shared memory");
    };
    assert_eq!(wire_notes.len(), notes.len());
    assert_eq!(wire_notes[0].start_tick(), notes[0].start_tick);
    assert_eq!(wire_notes.last().unwrap().key(), notes.last().unwrap().key);

    materialize_mixer_graph(graph, &receiver).unwrap();
    let MidiNoteBatch::Inline {
        notes: materialized,
    } = &graph.midi_clips[0].notes
    else {
        panic!("snapshot MIDI notes were not materialized");
    };
    assert_eq!(materialized, &notes);
}

#[test]
fn fixed_midi_layout_rejects_wrong_magic_and_truncation() {
    let note = LiveMidiNote {
        start_tick: 10,
        duration_ticks: 20,
        channel: 1,
        key: 60,
        velocity: 100,
        release_velocity: 50,
    };
    let mut encoded = encoded_midi_notes(std::slice::from_ref(&note)).unwrap();
    encoded[0] ^= 0xff;
    assert!(matches!(
        parse_midi_notes(&encoded),
        Err(TransportError::InvalidSharedLayout)
    ));

    let encoded = encoded_midi_notes(std::slice::from_ref(&note)).unwrap();
    assert!(matches!(
        parse_midi_notes(&encoded[..encoded.len() - 1]),
        Err(TransportError::InvalidSharedLayout)
    ));
}

#[test]
fn invalid_shared_range_and_stale_allocation_are_rejected() {
    let response = ControlResponse {
        request_id: 9,
        result: ControlResult::RecordingWaveform {
            waveform: RecordingWaveform {
                sample_rate: 48_000,
                channels: 2,
                frame_count: 1,
                start_frame: 0,
                end_frame: 1,
                frames_per_bucket: 1,
                bucket_count: 1,
                peaks: BinaryPayload::inline(vec![3; INLINE_BLOB_LIMIT + 1]),
            },
        },
    };
    let mut leases = LeaseRegistry::new();
    let mut packet = encode_response(response, &mut leases).unwrap();
    let mut wire = decode_body::<ControlResponse>(&packet.body).unwrap();
    let ControlResult::RecordingWaveform { waveform } = &mut wire.result else {
        panic!("wrong response");
    };
    let BinaryPayload::Shared { reference } = &mut waveform.peaks else {
        panic!("payload was not shared");
    };
    reference.offset = u64::MAX;
    packet.body = encode_body(&wire).unwrap();
    let mut receiver = ArenaReceiver::new(1);
    assert!(matches!(
        decode_response(packet, &mut receiver),
        Err(TransportError::InvalidRange)
    ));

    let mut registry = LeaseRegistry::new();
    let (reference, offer) = registry.allocate(&[1, 2, 3]).unwrap();
    assert_eq!(registry.len(), 1);
    assert_eq!(registry.bytes(), 3);
    let mut receiver = ArenaReceiver::new(1);
    receiver.register_offers(vec![offer.unwrap()]).unwrap();
    assert_eq!(receiver.resolve(reference).unwrap(), &[1, 2, 3]);
    registry.release(&[reference.lease_id]);
    assert_eq!(registry.bytes(), 0);
    assert!(matches!(
        receiver.resolve(reference),
        Err(TransportError::StaleAllocation)
    ));
}

#[test]
fn warm_allocations_reuse_one_persistent_consumer_mapping() {
    let mut sender = LeaseRegistry::with_session_epoch(17);
    let mut receiver = ArenaReceiver::new(17);
    let (first, offer) = sender.allocate(&vec![1; 128 * 1024]).unwrap();
    receiver.register_offers(vec![offer.unwrap()]).unwrap();
    assert_eq!(receiver.resolve(first).unwrap()[0], 1);
    sender.release(&[first.lease_id]);

    let (second, offer) = sender.allocate(&vec![2; 128 * 1024]).unwrap();
    assert!(offer.is_none());
    assert_eq!(first.region_id, second.region_id);
    assert_ne!(first.allocation_generation, second.allocation_generation);
    assert_eq!(receiver.resolve(second).unwrap()[0], 2);
}

#[test]
fn arena_release_without_peer_verification_quarantines_the_region() {
    let mut sender = LeaseRegistry::with_session_epoch(18);
    let (first, offer) = sender.allocate(&vec![1; 128 * 1024]).unwrap();
    let first_region = first.region_id;
    assert!(offer.is_some());

    sender.release(&[first.lease_id]);
    assert_eq!(sender.diagnostics().quarantined_regions, 1);
    let (second, second_offer) = sender.allocate(&vec![2; 128 * 1024]).unwrap();
    assert_ne!(second.region_id, first_region);
    assert!(second_offer.is_some());
}

#[test]
fn packet_attachment_budget_accepts_exact_limit_and_rejects_overflow() {
    assert_eq!(
        checked_packet_attachment_bytes(MAX_MESSAGE_BYTES - 1, 1).unwrap(),
        MAX_MESSAGE_BYTES
    );
    assert!(matches!(
        checked_packet_attachment_bytes(MAX_MESSAGE_BYTES, 1),
        Err(TransportError::MessageTooLarge)
    ));
    assert!(matches!(
        checked_packet_attachment_bytes(usize::MAX, 1),
        Err(TransportError::MessageTooLarge)
    ));
}

#[test]
fn failed_attachment_build_releases_allocations_transactionally() {
    let mut sender = LeaseRegistry::with_session_epoch(19);
    {
        let mut builder = AttachmentBuilder::new(&mut sender);
        builder.push(&vec![1; 96 * 1024]).unwrap();
        builder.total_bytes = MAX_MESSAGE_BYTES;
        assert!(matches!(
            builder.push(&[2]),
            Err(TransportError::MessageTooLarge)
        ));
    }
    assert!(sender.is_empty());
    assert_eq!(sender.bytes(), 0);
}

#[test]
fn outstanding_lease_limit_returns_busy_without_an_unbounded_waiter() {
    let mut sender = LeaseRegistry::with_session_epoch(29);
    let mut leases = Vec::with_capacity(MAX_OUTSTANDING_LEASES);
    for value in 0..MAX_OUTSTANDING_LEASES {
        let (reference, _) = sender.allocate(&[value as u8]).unwrap();
        leases.push(reference.lease_id);
    }
    assert!(matches!(
        sender.allocate(&[0]),
        Err(TransportError::LeaseCapacity)
    ));
    assert_eq!(sender.diagnostics().busy, 1);
    sender.abort(&leases);
    assert!(sender.is_empty());
}

#[test]
fn four_megabyte_napi_attachment_keeps_messagepack_body_small() {
    let bytes = vec![0x7f; 4 * 1024 * 1024];
    let request = ControlRequest {
        request_id: 77,
        command: ControlCommand::BenchmarkEcho {
            payload: BinaryPayload::Attachment {
                index: 0,
                offset: 0,
                length: bytes.len() as u64,
            },
        },
    };
    let mut sender = LeaseRegistry::with_session_epoch(31);
    let packet =
        encode_request_with_attachments(request, &[bytes.as_slice()], &mut sender).unwrap();
    assert!(packet.body.len() < 8 * 1024);
    assert_eq!(packet.region_offers.len(), 1);

    let mut receiver = ArenaReceiver::new(31);
    let (decoded, releases) = decode_request(packet, &mut receiver).unwrap();
    assert_eq!(releases.len(), 1);
    let ControlCommand::BenchmarkEcho { payload } = decoded.command else {
        panic!("wrong command");
    };
    assert_eq!(payload.as_inline().map(<[u8]>::len), Some(bytes.len()));
}

#[test]
fn expired_lease_quarantines_its_region_until_session_close() {
    let mut sender = LeaseRegistry::with_session_epoch(41);
    let (first, _) = sender.allocate(&vec![1; 96 * 1024]).unwrap();
    sender.entries.get_mut(&first.lease_id).unwrap().created_at = Instant::now() - LEASE_TIMEOUT;
    assert_eq!(sender.reap_expired(), vec![first.lease_id]);
    assert_eq!(sender.diagnostics().quarantined_regions, 1);

    let (second, offer) = sender.allocate(&vec![2; 96 * 1024]).unwrap();
    assert_ne!(first.region_id, second.region_id);
    assert!(offer.is_some());
}

#[test]
fn out_of_order_release_coalesces_extents_for_a_larger_allocation() {
    let mut sender = LeaseRegistry::with_session_epoch(23);
    let mut receiver = ArenaReceiver::new(23);
    let (first, offer) = sender.allocate(&vec![1; 256 * 1024]).unwrap();
    receiver.register_offers(vec![offer.unwrap()]).unwrap();
    let (second, _) = sender.allocate(&vec![2; 256 * 1024]).unwrap();
    let (third, _) = sender.allocate(&vec![3; 256 * 1024]).unwrap();
    sender.release(&[second.lease_id]);
    sender.release(&[first.lease_id]);
    sender.release(&[third.lease_id]);

    let before = sender.diagnostics().region_count;
    let (_, offer) = sender.allocate(&vec![4; 768 * 1024]).unwrap();
    assert!(offer.is_none());
    assert_eq!(sender.diagnostics().region_count, before);
}

#[test]
fn stale_allocation_generation_is_rejected() {
    let response = ControlResponse {
        request_id: 1,
        result: ControlResult::RecordingWaveform {
            waveform: RecordingWaveform {
                sample_rate: 48_000,
                channels: 2,
                frame_count: 1,
                start_frame: 0,
                end_frame: 1,
                frames_per_bucket: 1,
                bucket_count: 1,
                peaks: BinaryPayload::inline(vec![3; INLINE_BLOB_LIMIT + 1]),
            },
        },
    };
    let mut leases = LeaseRegistry::new();
    let mut packet = encode_response(response, &mut leases).unwrap();
    let ControlResponse {
        result: ControlResult::RecordingWaveform { mut waveform },
        ..
    } = decode_body::<ControlResponse>(&packet.body).unwrap()
    else {
        panic!("wrong response");
    };
    let BinaryPayload::Shared { mut reference } = waveform.peaks else {
        panic!("payload was not shared");
    };
    reference.allocation_generation = reference.allocation_generation.wrapping_add(1);
    waveform.peaks = BinaryPayload::Shared { reference };
    packet.body = encode_body(&ControlResponse {
        request_id: 1,
        result: ControlResult::RecordingWaveform { waveform },
    })
    .unwrap();
    let mut receiver = ArenaReceiver::new(1);
    assert!(matches!(
        decode_response(packet, &mut receiver),
        Err(TransportError::StaleAllocation)
    ));
}

#[test]
fn telemetry_snapshot_is_coherent() {
    let memory = create_telemetry_page(64, 9, 1).unwrap();
    let writer = TelemetryWriter::map(memory.clone()).unwrap();
    let reader = TelemetryReader::map(memory).unwrap();
    assert_eq!(reader.capacity(), 64);
    assert_eq!(reader.epoch(), 9);
    let expected = TelemetrySnapshot {
        epoch: 9,
        graph_revision: 4,
        callback_generation: 12,
        transport_state: 1,
        position_frames: 512,
        sample_rate: 48_000,
        meters: vec![TelemetryMeter {
            runtime_handle: 7,
            pre_left: 0.1,
            pre_right: 0.2,
            post_left: 0.3,
            post_right: 0.4,
            held_left: 0.5,
            held_right: 0.6,
            clipped: true,
        }],
    };
    writer.publish(&expected).unwrap();
    assert_eq!(reader.read(), Some(expected));
}

#[test]
fn telemetry_capacity_rounds_up_without_a_track_limit() {
    let memory = create_telemetry_page(65, 11, 1).unwrap();
    let writer = TelemetryWriter::map(memory).unwrap();
    assert_eq!(writer.capacity(), 128);
    assert_eq!(writer.epoch(), 11);
}

#[test]
fn short_persistent_page_is_rejected_before_atomic_access() {
    let memory = SharedMemory::create(std::num::NonZeroUsize::new(8).unwrap(), 1).unwrap();
    assert!(matches!(
        TelemetryReader::map(memory),
        Err(TransportError::InvalidSharedLayout)
    ));
}

#[test]
fn parameter_ring_reserves_gesture_boundaries() {
    let memory = create_parameter_ring(3, 1).unwrap();
    let producer = ParameterProducer::map(memory.clone()).unwrap();
    let consumer = ParameterConsumer::map(memory).unwrap();
    let command = |sequence, gesture| ParameterCommand {
        session_epoch: 3,
        sequence,
        target_kind: ParameterTargetKind::Plugin,
        runtime_handle: 2,
        parameter_id: 8,
        target_generation: 4,
        normalized: 0.5,
        gesture,
    };
    for sequence in 0..(PARAMETER_RING_CAPACITY - PARAMETER_BOUNDARY_RESERVE as u32) {
        assert!(matches!(
            producer.enqueue(command(u64::from(sequence), ParameterGesture::Perform)),
            ParameterEnqueue::Queued { .. }
        ));
    }
    assert_eq!(
        producer.usage(),
        (
            u64::from(PARAMETER_RING_CAPACITY) - PARAMETER_BOUNDARY_RESERVE,
            u64::from(PARAMETER_RING_CAPACITY)
        )
    );
    assert_eq!(
        producer.enqueue(command(9000, ParameterGesture::Perform)),
        ParameterEnqueue::SoftFull
    );
    assert!(matches!(
        producer.enqueue(command(9001, ParameterGesture::End)),
        ParameterEnqueue::Queued { .. }
    ));
    let mut drained = Vec::new();
    consumer.drain(PARAMETER_RING_CAPACITY as usize, &mut drained);
    assert_eq!(
        drained.last().map(|value| value.gesture),
        Some(ParameterGesture::End)
    );
}

#[test]
fn parameter_ring_discards_a_stale_session_epoch() {
    let memory = create_parameter_ring(3, 1).unwrap();
    let producer = ParameterProducer::map(memory.clone()).unwrap();
    let consumer = ParameterConsumer::map(memory).unwrap();
    let stale = ParameterCommand {
        session_epoch: 2,
        sequence: 1,
        target_kind: ParameterTargetKind::Plugin,
        runtime_handle: 2,
        parameter_id: 8,
        target_generation: 4,
        normalized: 0.5,
        gesture: ParameterGesture::Begin,
    };
    assert_eq!(producer.enqueue(stale), ParameterEnqueue::StaleEpoch);
    let mut drained = Vec::new();
    consumer.drain(8, &mut drained);
    assert!(drained.is_empty());
}

#[test]
fn loom_models_spsc_release_acquire_publication() {
    loom::model(|| {
        use loom::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        use loom::thread;

        let payload = Arc::new(AtomicUsize::new(0));
        let head = Arc::new(AtomicUsize::new(0));
        let producer_payload = payload.clone();
        let producer_head = head.clone();
        let producer = thread::spawn(move || {
            producer_payload.store(42, Ordering::Relaxed);
            producer_head.store(1, Ordering::Release);
        });
        let consumer = thread::spawn(move || {
            if head.load(Ordering::Acquire) == 1 {
                assert_eq!(payload.load(Ordering::Relaxed), 42);
            }
        });
        producer.join().unwrap();
        consumer.join().unwrap();
    });
}

#[test]
fn loom_models_telemetry_seqlock_publication() {
    loom::model(|| {
        use loom::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        use loom::thread;

        let sequence = Arc::new(AtomicUsize::new(0));
        let payload = Arc::new(AtomicUsize::new(0));
        let writer_sequence = sequence.clone();
        let writer_payload = payload.clone();
        let writer = thread::spawn(move || {
            writer_sequence.fetch_add(1, Ordering::AcqRel);
            writer_payload.store(9, Ordering::Relaxed);
            writer_sequence.fetch_add(1, Ordering::Release);
        });
        let reader = thread::spawn(move || {
            let before = sequence.load(Ordering::Acquire);
            if before & 1 == 0 {
                let value = payload.load(Ordering::Relaxed);
                let after = sequence.load(Ordering::Acquire);
                if before == after && after != 0 {
                    assert_eq!(value, 9);
                }
            }
        });
        writer.join().unwrap();
        reader.join().unwrap();
    });
}

#[test]
fn two_sequential_shared_benchmark_echoes_with_lease_release() {
    let mut request_leases = LeaseRegistry::with_session_epoch(1);
    let mut request_receiver = ArenaReceiver::new(1);
    let mut response_leases = LeaseRegistry::with_session_epoch(1);
    let mut response_receiver = ArenaReceiver::new(1);

    for (iteration, request_id) in [1_u64, 2].into_iter().enumerate() {
        let payload = vec![request_id as u8; INLINE_BLOB_LIMIT + 1];
        let attachments = [payload.as_slice()];
        let request = ControlRequest {
            request_id,
            command: ControlCommand::BenchmarkEcho {
                payload: BinaryPayload::Attachment {
                    index: 0,
                    offset: 0,
                    length: payload.len() as u64,
                },
            },
        };
        let request_packet =
            encode_request_with_attachments(request, &attachments, &mut request_leases).unwrap();
        assert_eq!(
            request_packet.region_offers.len(),
            usize::from(iteration == 0),
            "only the first request offers its persistent region"
        );
        let (decoded, request_release) =
            decode_request_deferred(request_packet, &mut request_receiver).unwrap();
        let ControlCommand::BenchmarkEcho {
            payload: BinaryPayload::Shared { reference },
        } = decoded.command
        else {
            panic!("expected shared deferred payload");
        };
        let response = ControlResponse {
            request_id,
            result: ControlResult::BenchmarkEcho {
                payload: BinaryPayload::Shared { reference },
            },
        };
        let response_packet =
            encode_response_from_arena(response, &mut response_leases, &request_receiver).unwrap();
        assert_eq!(
            response_packet.region_offers.len(),
            usize::from(iteration == 0),
            "only the first response offers its persistent region"
        );
        // Client frees the request lease after the host has copied it into the response.
        request_leases.release(&request_release);
        let (decoded, _attachments, response_release) =
            decode_response_to_attachments(response_packet, &mut response_receiver).unwrap();
        assert_eq!(decoded.request_id, request_id);
        assert_eq!(response_release.len(), 1);
        response_leases.release(&response_release);
        assert_eq!(
            request_leases.len(),
            0,
            "request leases should be free after echo {request_id}"
        );
        assert_eq!(
            response_leases.len(),
            0,
            "response leases should be free after echo {request_id}"
        );
    }
}
