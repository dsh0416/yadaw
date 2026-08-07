use std::sync::Mutex;

use super::*;

// Midi realtime rings and the actor share process-global state; serialize those tests.
static GLOBAL_MIDI_TEST_LOCK: Mutex<()> = Mutex::new(());

struct ExternalSyncReset(Arc<RealtimeInputShared>);

impl Drop for ExternalSyncReset {
    fn drop(&mut self) {
        self.0.external_sync_enabled.store(false, Ordering::Release);
    }
}

fn prefs(
    enabled: bool,
    source: Option<(&str, &str)>,
    offsets: BTreeMap<String, f64>,
    control_ports: BTreeSet<String>,
    capture_all_controls: bool,
) -> MidiSyncPreferences {
    MidiSyncPreferences {
        enabled,
        source_port_id: source.map(|(id, _)| id.to_owned()),
        source_port_name: source.map(|(_, name)| name.to_owned()),
        input_offsets_ms: offsets,
        control_port_ids: control_ports,
        capture_all_controls,
    }
}

#[allow(clippy::too_many_arguments)]
fn message_sink<'a>(
    preferences: &'a MidiSyncPreferences,
    clock: &'a mut MidiClockSlave,
    ignored: &'a mut u64,
    panic: &'a AtomicBool,
    pending: &'a mut Vec<PendingMidiEvent>,
    generation: &'a mut u64,
    controls: &'a mut VecDeque<MidiControlEvent>,
    recording: &'a mut Option<MidiRecordingSession>,
) -> MessageSink<'a> {
    MessageSink {
        preferences,
        clock,
        ignored_system_messages: ignored,
        panic_requested: panic,
        pending_events: pending,
        control_generation: generation,
        control_events: controls,
        recording,
    }
}

#[allow(clippy::type_complexity)]
fn callback_state(
    short_capacity: usize,
    sysex_capacity: usize,
    descriptor_capacity: usize,
) -> (
    CallbackState,
    HeapCons<ShortMidiPacket>,
    HeapCons<u8>,
    HeapCons<SysExDescriptor>,
    Arc<AtomicU64>,
    Arc<AtomicBool>,
) {
    let short_ring = HeapRb::<ShortMidiPacket>::new(short_capacity.max(1));
    let (short, short_consumer) = short_ring.split();
    let byte_ring = HeapRb::<u8>::new(sysex_capacity.max(1));
    let (sysex_bytes, sysex_byte_consumer) = byte_ring.split();
    let descriptor_ring = HeapRb::<SysExDescriptor>::new(descriptor_capacity.max(1));
    let (sysex_descriptors, sysex_descriptor_consumer) = descriptor_ring.split();
    let dropped = Arc::new(AtomicU64::new(0));
    let panic_requested = Arc::new(AtomicBool::new(false));
    (
        CallbackState {
            timestamp_offset: Arc::new(AtomicI64::new(i64::MIN)),
            short,
            sysex_bytes,
            sysex_descriptors,
            dropped: Arc::clone(&dropped),
            panic_requested: Arc::clone(&panic_requested),
        },
        short_consumer,
        sysex_byte_consumer,
        sysex_descriptor_consumer,
        dropped,
        panic_requested,
    )
}

#[test]
fn stable_port_key_is_deterministic_and_differs_by_id() {
    assert_eq!(stable_port_key("port-a"), stable_port_key("port-a"));
    assert_ne!(stable_port_key("port-a"), stable_port_key("port-b"));
    assert_ne!(stable_port_key(""), stable_port_key("x"));
    let expected = b"midi-clock"
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    assert_eq!(stable_port_key("midi-clock"), expected);
    assert_eq!(stable_port_key(""), 0xcbf2_9ce4_8422_2325);
}

#[test]
fn validate_preferences_accepts_valid_bounds_and_paired_source() {
    assert!(
        validate_preferences(&prefs(
            true,
            Some(("clock", "Clock")),
            BTreeMap::from([
                ("a".to_owned(), -500.0),
                ("b".to_owned(), 0.0),
                ("c".to_owned(), 500.0),
            ]),
            BTreeSet::new(),
            false,
        ))
        .is_ok()
    );
    assert!(
        validate_preferences(&prefs(false, None, BTreeMap::new(), BTreeSet::new(), true,)).is_ok()
    );
}

#[test]
fn validate_preferences_rejects_mismatched_source_fields() {
    assert!(
        validate_preferences(&MidiSyncPreferences {
            enabled: true,
            source_port_id: Some("only-id".into()),
            source_port_name: None,
            input_offsets_ms: BTreeMap::new(),
            control_port_ids: BTreeSet::new(),
            capture_all_controls: false,
        })
        .is_err()
    );
    assert!(
        validate_preferences(&MidiSyncPreferences {
            enabled: true,
            source_port_id: None,
            source_port_name: Some("only-name".into()),
            input_offsets_ms: BTreeMap::new(),
            control_port_ids: BTreeSet::new(),
            capture_all_controls: false,
        })
        .is_err()
    );
}

#[test]
fn rejects_out_of_range_timing_offsets() {
    assert!(
        validate_preferences(&prefs(
            true,
            None,
            BTreeMap::from([("port".to_owned(), 500.1)]),
            BTreeSet::new(),
            false,
        ))
        .is_err()
    );
    assert!(
        validate_preferences(&prefs(
            true,
            None,
            BTreeMap::from([("port".to_owned(), -500.1)]),
            BTreeSet::new(),
            false,
        ))
        .is_err()
    );
    assert!(
        validate_preferences(&prefs(
            true,
            None,
            BTreeMap::from([("port".to_owned(), f64::NAN)]),
            BTreeSet::new(),
            false,
        ))
        .is_err()
    );
    assert!(
        validate_preferences(&prefs(
            true,
            None,
            BTreeMap::from([("port".to_owned(), f64::INFINITY)]),
            BTreeSet::new(),
            false,
        ))
        .is_err()
    );
}

#[test]
fn unavailable_snapshot_reports_lost_sync_with_error() {
    let snapshot = unavailable_snapshot("MIDI input actor is unavailable");
    assert!(snapshot.ports.is_empty());
    assert_eq!(snapshot.sync.state, "lost");
    assert_eq!(
        snapshot.sync.error.as_deref(),
        Some("MIDI input actor is unavailable")
    );
    assert!(snapshot.control_events.is_empty());
    assert_eq!(snapshot.captured_at, 0);
    assert_eq!(snapshot.sync.dropped_events, 0);
    assert_eq!(snapshot.sync.ignored_system_messages, 0);
    assert!(snapshot.sync.source_port_id.is_none());
    assert!(snapshot.sync.effective_bpm.is_none());
}

#[test]
fn monotonic_micros_is_non_decreasing() {
    let first = monotonic_micros();
    let second = monotonic_micros();
    assert!(second >= first);
}

#[test]
fn callback_state_calibrates_and_queues_short_packets() {
    let (mut state, mut short, _, _, dropped, panic) = callback_state(4, 8, 2);
    state.receive(1_000, &[0x90, 60, 100]);
    let packet = short.try_pop().expect("short packet");
    assert_eq!(packet.length, 3);
    assert_eq!(&packet.bytes[..3], &[0x90, 60, 100]);
    assert_eq!(dropped.load(Ordering::Relaxed), 0);
    assert!(!panic.load(Ordering::Relaxed));

    // Reuses the calibrated offset for the next packet.
    let first_ts = packet.timestamp_micros;
    state.receive(1_500, &[0x80, 60, 0]);
    let second = short.try_pop().expect("second packet");
    assert_eq!(second.timestamp_micros.abs_diff(first_ts), 500);
    assert_eq!(&second.bytes[..3], &[0x80, 60, 0]);
}

#[test]
fn callback_state_queues_sysex_and_drops_when_full_or_oversized() {
    let (mut state, _, mut bytes, mut descriptors, dropped, _panic) = callback_state(2, 64, 1);
    state.receive(10, &[0xF0, 1, 2, 3, 0xF7]);
    // Leave the descriptor queued so the capacity-1 ring reports full.
    // Length must stay > 3 so the short-packet path is not taken.
    state.receive(11, &[0xF0, 9, 10, 0xF7]);
    assert_eq!(dropped.load(Ordering::Relaxed), 1);

    let descriptor = descriptors.try_pop().expect("sysex descriptor");
    assert_eq!(descriptor.length, 5);
    let mut payload = Vec::new();
    for _ in 0..descriptor.length {
        payload.push(bytes.try_pop().expect("sysex byte"));
    }
    assert_eq!(payload, vec![0xF0, 1, 2, 3, 0xF7]);
    assert!(descriptors.try_pop().is_none());

    // Oversized messages are dropped without requesting panic.
    let (mut state, _, _, _, dropped, panic) = callback_state(2, 8, 2);
    let oversized = vec![0xF0; MIDI_MAX_SYSEX_BYTES + 1];
    state.receive(12, &oversized);
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
    assert!(!panic.load(Ordering::Relaxed));
}

#[test]
fn callback_state_marks_panic_when_short_queue_is_full() {
    let (mut state, mut short, _, _, dropped, panic) = callback_state(1, 4, 1);
    state.receive(1, &[0x90, 1, 1]);
    assert!(short.try_pop().is_some());
    // Fill the single slot, then overflow.
    state.receive(2, &[0x90, 2, 2]);
    state.receive(3, &[0x90, 3, 3]);
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
    assert!(panic.load(Ordering::Relaxed));
}

#[test]
fn realtime_consumer_defers_future_events_and_exposes_flags() {
    let _guard = GLOBAL_MIDI_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let shared = RealtimeInputShared::get();
    let _external_sync_reset = ExternalSyncReset(Arc::clone(&shared));
    let mut producer = Prod::new(Arc::clone(&shared.events));
    let mut sysex_prod = Prod::new(Arc::clone(&shared.sysex));
    let mut consumer = realtime_consumer();
    // Drain any leftover events from other tests sharing the process-global rings.
    while consumer.next_before(u64::MAX).is_some() {}
    let mut drain_byte = [0_u8; 1];
    while consumer.pop_sysex(&mut drain_byte) {}

    shared.panic_requested.store(true, Ordering::Release);
    shared.sync_lost.store(true, Ordering::Release);
    shared.external_sync_enabled.store(true, Ordering::Release);
    shared
        .presentation_latency_micros
        .store(1_234, Ordering::Relaxed);

    assert!(
        producer
            .try_push(RealtimeMidiEvent {
                timestamp_micros: 10,
                port_key: 7,
                channel: 1,
                message: RealtimeMidiMessage::NoteOn {
                    key: 60,
                    velocity: 90,
                },
            })
            .is_ok()
    );
    assert!(
        producer
            .try_push(RealtimeMidiEvent {
                timestamp_micros: 10_000,
                port_key: 7,
                channel: 1,
                message: RealtimeMidiMessage::NoteOff {
                    key: 60,
                    velocity: 0,
                },
            })
            .is_ok()
    );
    assert!(sysex_prod.try_push(0xF0).is_ok());
    assert!(sysex_prod.try_push(0xF7).is_ok());

    assert!(consumer.external_sync_enabled());
    assert_eq!(consumer.presentation_latency_micros(), 1_234);
    consumer.set_presentation_latency_micros(55);
    assert_eq!(consumer.presentation_latency_micros(), 55);
    assert!(consumer.take_panic());
    assert!(!consumer.take_panic());
    assert!(consumer.take_sync_lost());
    assert!(!consumer.take_sync_lost());

    let event = consumer.next_before(100).expect("near event");
    assert_eq!(
        event.message,
        RealtimeMidiMessage::NoteOn {
            key: 60,
            velocity: 90
        }
    );
    assert!(consumer.next_before(100).is_none());
    let deferred = consumer.next_before(20_000).expect("deferred future event");
    assert_eq!(
        deferred.message,
        RealtimeMidiMessage::NoteOff {
            key: 60,
            velocity: 0
        }
    );

    let mut sysex = [0_u8; 2];
    assert!(consumer.pop_sysex(&mut sysex));
    assert_eq!(sysex, [0xF0, 0xF7]);
    assert!(!consumer.pop_sysex(&mut [0]));
}

#[test]
fn captures_note_and_control_change_events_for_shortcut_ports() {
    let preferences = prefs(
        false,
        None,
        BTreeMap::new(),
        BTreeSet::from(["controller".to_owned()]),
        false,
    );
    let mut clock = MidiClockSlave::default();
    let mut ignored = 0;
    let panic = AtomicBool::new(false);
    let mut pending = Vec::new();
    let mut generation = 0;
    let mut controls = VecDeque::new();
    let mut recording = None;
    process_messages(
        &mut message_sink(
            &preferences,
            &mut clock,
            &mut ignored,
            &panic,
            &mut pending,
            &mut generation,
            &mut controls,
            &mut recording,
        ),
        "controller",
        "Studio Controller",
        stable_port_key("controller"),
        123,
        vec![
            MidiInputMessage::NoteOn(2, 36, 100),
            MidiInputMessage::ControlChange(2, 64, 127),
        ],
    );

    assert_eq!(generation, 2);
    assert_eq!(controls.len(), 2);
    assert!(matches!(
        controls.front().map(|event| &event.kind),
        Some(MidiControlEventKind::Note {
            number: 36,
            value: 100
        })
    ));
    assert_eq!(controls.back().map(|event| event.channel), Some(2));
    assert_eq!(pending.len(), 2);
}

#[test]
fn process_messages_routes_clock_source_and_system_side_effects() {
    let preferences = prefs(
        true,
        Some(("clock", "Clock")),
        BTreeMap::new(),
        BTreeSet::new(),
        false,
    );
    let mut clock = MidiClockSlave::default();
    clock.set_enabled(true);
    let mut ignored = 0;
    let panic = AtomicBool::new(false);
    let mut pending = Vec::new();
    let mut generation = 0;
    let mut controls = VecDeque::new();
    let mut recording = None;
    process_messages(
        &mut message_sink(
            &preferences,
            &mut clock,
            &mut ignored,
            &panic,
            &mut pending,
            &mut generation,
            &mut controls,
            &mut recording,
        ),
        "clock",
        "Clock",
        stable_port_key("clock"),
        50,
        vec![
            MidiInputMessage::Start,
            MidiInputMessage::Clock,
            MidiInputMessage::SongPosition(4),
            MidiInputMessage::Stop,
            MidiInputMessage::ActiveSensing,
            MidiInputMessage::IgnoredSystem(0xF1),
            MidiInputMessage::SystemReset,
            MidiInputMessage::NoteOn(0, 40, 10),
            MidiInputMessage::NoteOn(0, 41, 0),
        ],
    );

    assert!(panic.load(Ordering::Relaxed));
    assert_eq!(ignored, 2);
    assert!(
        pending
            .iter()
            .any(|event| matches!(event.message, MidiInputMessage::Start))
    );
    assert!(
        pending
            .iter()
            .any(|event| matches!(event.message, MidiInputMessage::NoteOn(0, 40, 10)))
    );
    // Velocity-zero note-on is still recordable, but not a control shortcut note.
    assert!(controls.is_empty());
}

#[test]
fn process_messages_capture_all_controls_evicts_oldest_events() {
    let preferences = prefs(false, None, BTreeMap::new(), BTreeSet::new(), true);
    let mut clock = MidiClockSlave::default();
    let mut ignored = 0;
    let panic = AtomicBool::new(false);
    let mut pending = Vec::new();
    let mut generation = 0;
    let mut controls = VecDeque::new();
    let mut recording = None;
    let messages = (0..(CONTROL_EVENT_CAPACITY as u8 + 3))
        .map(|index| MidiInputMessage::ControlChange(0, index, 1))
        .collect::<Vec<_>>();
    process_messages(
        &mut message_sink(
            &preferences,
            &mut clock,
            &mut ignored,
            &panic,
            &mut pending,
            &mut generation,
            &mut controls,
            &mut recording,
        ),
        "any",
        "Any",
        1,
        1,
        messages,
    );
    assert_eq!(controls.len(), CONTROL_EVENT_CAPACITY);
    assert_eq!(generation, CONTROL_EVENT_CAPACITY as u64 + 3);
    assert_eq!(
        controls.front().map(|event| event.generation),
        Some(4),
        "oldest three control events should be evicted"
    );
}

#[allow(clippy::type_complexity)]
fn actor_state_with_local_rings(
    preferences: MidiSyncPreferences,
    pending_events: Vec<PendingMidiEvent>,
) -> (
    ActorState,
    Cons<Arc<HeapRb<RealtimeMidiEvent>>>,
    Cons<Arc<HeapRb<u8>>>,
) {
    let events = Arc::new(HeapRb::new(64));
    let sysex = Arc::new(HeapRb::new(64));
    let shared = RealtimeInputShared::get();
    let state = ActorState {
        preferences,
        ports: Vec::new(),
        connections: BTreeMap::new(),
        route_port_ids: BTreeSet::new(),
        all_inputs: false,
        clock: MidiClockSlave::default(),
        ignored_system_messages: 0,
        error: None,
        realtime_events: Prod::new(Arc::clone(&events)),
        realtime_sysex: Prod::new(Arc::clone(&sysex)),
        realtime_shared: Arc::clone(&shared),
        pending_events,
        control_generation: 0,
        control_events: VecDeque::new(),
        recording: None,
    };
    (state, Cons::new(events), Cons::new(sysex))
}

#[test]
fn flush_realtime_events_maps_channel_voice_and_transport_messages() {
    let (mut state, mut events, mut sysex) = actor_state_with_local_rings(
        prefs(
            true,
            Some(("clock", "Clock")),
            BTreeMap::new(),
            BTreeSet::new(),
            false,
        ),
        vec![
            PendingMidiEvent {
                timestamp_micros: 1,
                port_key: 9,
                message: MidiInputMessage::NoteOff(3, 10, 20),
            },
            PendingMidiEvent {
                timestamp_micros: 2,
                port_key: 9,
                message: MidiInputMessage::PolyPressure(3, 11, 21),
            },
            PendingMidiEvent {
                timestamp_micros: 3,
                port_key: 9,
                message: MidiInputMessage::ProgramChange(3, 5),
            },
            PendingMidiEvent {
                timestamp_micros: 4,
                port_key: 9,
                message: MidiInputMessage::ChannelPressure(3, 77),
            },
            PendingMidiEvent {
                timestamp_micros: 5,
                port_key: 9,
                message: MidiInputMessage::PitchBend(3, 8192),
            },
            PendingMidiEvent {
                timestamp_micros: 6,
                port_key: 9,
                message: MidiInputMessage::SysEx(vec![0xF0, 0x7E, 0xF7]),
            },
            PendingMidiEvent {
                timestamp_micros: 7,
                port_key: 9,
                message: MidiInputMessage::Continue,
            },
            PendingMidiEvent {
                timestamp_micros: 8,
                port_key: 9,
                message: MidiInputMessage::ActiveSensing,
            },
        ],
    );
    state.clock.set_enabled(true);

    flush_realtime_events(&mut state);
    assert!(state.pending_events.is_empty());

    let mut messages = Vec::new();
    while let Some(event) = events.try_pop() {
        messages.push(event.message);
        if matches!(event.message, RealtimeMidiMessage::SysEx { length: 3 }) {
            let mut bytes = [0_u8; 3];
            for slot in &mut bytes {
                *slot = sysex.try_pop().expect("sysex byte");
            }
            assert_eq!(bytes, [0xF0, 0x7E, 0xF7]);
        }
    }
    assert!(messages.contains(&RealtimeMidiMessage::NoteOff {
        key: 10,
        velocity: 20
    }));
    assert!(messages.contains(&RealtimeMidiMessage::PolyPressure {
        key: 11,
        pressure: 21
    }));
    assert!(messages.contains(&RealtimeMidiMessage::ProgramChange { program: 5 }));
    assert!(messages.contains(&RealtimeMidiMessage::ChannelPressure { pressure: 77 }));
    assert!(messages.contains(&RealtimeMidiMessage::PitchBend { value: 8192 }));
    assert!(messages.contains(&RealtimeMidiMessage::SysEx { length: 3 }));
    assert!(messages.contains(&RealtimeMidiMessage::Continue));
    assert!(
        !messages
            .iter()
            .any(|message| matches!(message, RealtimeMidiMessage::Clock { .. }))
    );
}

#[test]
fn snapshot_maps_clock_states_and_aggregates_dropped_events() {
    let shared = RealtimeInputShared::get();
    shared.dropped.store(4, Ordering::Relaxed);
    let (mut state, _events, _sysex) = actor_state_with_local_rings(
        prefs(
            true,
            Some(("src", "Source")),
            BTreeMap::new(),
            BTreeSet::new(),
            false,
        ),
        Vec::new(),
    );
    state.ports = vec![WireMidiInputPort {
        id: "src".into(),
        name: "Source".into(),
        connected: true,
    }];
    state.ignored_system_messages = 9;
    state.error = Some("boom".into());

    let internal = snapshot(&state);
    assert_eq!(internal.ports.len(), 1);
    assert_eq!(internal.sync.state, "internal");
    assert_eq!(internal.sync.source_port_id.as_deref(), Some("src"));
    assert_eq!(internal.sync.dropped_events, 4);
    assert_eq!(internal.sync.ignored_system_messages, 9);
    assert_eq!(internal.sync.error.as_deref(), Some("boom"));
    assert!(internal.captured_at > 0);

    state.clock.set_enabled(true);
    assert_eq!(snapshot(&state).sync.state, "waiting");

    state.clock.receive(&MidiInputMessage::Start, 0);
    assert_eq!(snapshot(&state).sync.state, "locking");

    // The first clock only arms the interval; twelve subsequent clocks lock.
    for pulse in 0..13 {
        state
            .clock
            .receive(&MidiInputMessage::Clock, pulse * 20_833);
    }
    assert_eq!(snapshot(&state).sync.state, "locked");

    state.clock.advance(20_833 * 12 + 50_000);
    assert_eq!(snapshot(&state).sync.state, "freewheel");

    state
        .clock
        .advance(20_833 * 12 + heron_dsp_runtime::midi_input::MIDI_CLOCK_FREEWHEEL_MICROS + 1);
    assert_eq!(snapshot(&state).sync.state, "lost");
}

#[test]
fn midi_input_actor_configure_rejects_invalid_preferences_and_snapshots() {
    let _guard = GLOBAL_MIDI_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let actor = MidiInputActor::start(prefs(false, None, BTreeMap::new(), BTreeSet::new(), false));
    let invalid = actor.configure(MidiSyncPreferences {
        enabled: true,
        source_port_id: Some("id".into()),
        source_port_name: None,
        input_offsets_ms: BTreeMap::new(),
        control_port_ids: BTreeSet::new(),
        capture_all_controls: false,
    });
    assert!(invalid.is_err());

    let snap = actor
        .configure(prefs(
            false,
            None,
            BTreeMap::from([("p".into(), 12.5)]),
            BTreeSet::new(),
            false,
        ))
        .expect("valid configure");
    assert_eq!(snap.sync.state, "internal");
    actor.update_routes(true, BTreeSet::from(["missing".into()]));
    let snapshot = actor.snapshot();
    assert_eq!(snapshot.sync.state, "internal");
}
