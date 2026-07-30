use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use midir::{Ignore, MidiInput, MidiInputConnection, MidiInputPort};
use ringbuf::{
    Cons, HeapCons, HeapProd, HeapRb, Prod,
    traits::{Consumer, Observer, Producer, Split},
};
use yadaw_dsp_runtime::{
    midi_input::{
        MIDI_MAX_SYSEX_BYTES, MIDI_SHORT_QUEUE_CAPACITY, MIDI_SYSEX_SLAB_BYTES, MidiClockSlave,
        MidiInputMessage, MidiInputParser, MidiSyncState,
    },
    protocol::{
        MidiControlEvent, MidiControlEventKind, MidiInputPort as WireMidiInputPort,
        MidiInputSnapshot, MidiSyncPreferences, MidiSyncRuntime,
    },
};

const PORT_POLL_INTERVAL: Duration = Duration::from_secs(1);
const ACTOR_POLL_INTERVAL: Duration = Duration::from_millis(20);
const SYSEX_DESCRIPTOR_CAPACITY: usize = 64;
const REALTIME_LOOKAHEAD: Duration = Duration::from_millis(50);
const CONTROL_EVENT_CAPACITY: usize = 64;

static PROCESS_EPOCH: OnceLock<Instant> = OnceLock::new();
static REALTIME_INPUT: OnceLock<Arc<RealtimeInputShared>> = OnceLock::new();

pub fn monotonic_micros() -> u64 {
    PROCESS_EPOCH
        .get_or_init(Instant::now)
        .elapsed()
        .as_micros()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeMidiMessage {
    NoteOff { key: u8, velocity: u8 },
    NoteOn { key: u8, velocity: u8 },
    PolyPressure { key: u8, pressure: u8 },
    ControlChange { controller: u8, value: u8 },
    ProgramChange { program: u8 },
    ChannelPressure { pressure: u8 },
    PitchBend { value: u16 },
    SysEx { length: u32 },
    Clock { effective_bpm_bits: u64 },
    Start,
    Continue,
    Stop,
    SongPosition { position: u16 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealtimeMidiEvent {
    pub timestamp_micros: u64,
    pub port_key: u64,
    pub channel: u8,
    pub message: RealtimeMidiMessage,
}

struct RealtimeInputShared {
    events: Arc<HeapRb<RealtimeMidiEvent>>,
    sysex: Arc<HeapRb<u8>>,
    panic_requested: Arc<AtomicBool>,
    sync_lost: AtomicBool,
    external_sync_enabled: AtomicBool,
    dropped: Arc<AtomicU64>,
    presentation_latency_micros: AtomicU64,
}

impl RealtimeInputShared {
    fn get() -> Arc<Self> {
        Arc::clone(REALTIME_INPUT.get_or_init(|| {
            Arc::new(Self {
                events: Arc::new(HeapRb::new(MIDI_SHORT_QUEUE_CAPACITY)),
                sysex: Arc::new(HeapRb::new(MIDI_SYSEX_SLAB_BYTES)),
                panic_requested: Arc::new(AtomicBool::new(false)),
                sync_lost: AtomicBool::new(false),
                external_sync_enabled: AtomicBool::new(false),
                dropped: Arc::new(AtomicU64::new(0)),
                presentation_latency_micros: AtomicU64::new(0),
            })
        }))
    }
}

pub struct RealtimeMidiConsumer {
    events: Cons<Arc<HeapRb<RealtimeMidiEvent>>>,
    sysex: Cons<Arc<HeapRb<u8>>>,
    shared: Arc<RealtimeInputShared>,
    pending: Option<RealtimeMidiEvent>,
}

impl RealtimeMidiConsumer {
    #[must_use]
    pub fn next_before(&mut self, deadline_micros: u64) -> Option<RealtimeMidiEvent> {
        let event = self.pending.take().or_else(|| self.events.try_pop())?;
        if event.timestamp_micros > deadline_micros {
            self.pending = Some(event);
            return None;
        }
        Some(event)
    }

    pub fn pop_sysex(&mut self, target: &mut [u8]) -> bool {
        for byte in target {
            let Some(value) = self.sysex.try_pop() else {
                return false;
            };
            *byte = value;
        }
        true
    }

    #[must_use]
    pub fn take_panic(&self) -> bool {
        self.shared.panic_requested.swap(false, Ordering::AcqRel)
    }

    #[must_use]
    pub fn take_sync_lost(&self) -> bool {
        self.shared.sync_lost.swap(false, Ordering::AcqRel)
    }

    #[must_use]
    pub fn external_sync_enabled(&self) -> bool {
        self.shared.external_sync_enabled.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn presentation_latency_micros(&self) -> u64 {
        self.shared
            .presentation_latency_micros
            .load(Ordering::Relaxed)
    }

    pub fn set_presentation_latency_micros(&self, value: u64) {
        self.shared
            .presentation_latency_micros
            .store(value, Ordering::Relaxed);
    }
}

#[must_use]
pub fn realtime_consumer() -> RealtimeMidiConsumer {
    let shared = RealtimeInputShared::get();
    RealtimeMidiConsumer {
        events: Cons::new(Arc::clone(&shared.events)),
        sysex: Cons::new(Arc::clone(&shared.sysex)),
        shared,
        pending: None,
    }
}

#[must_use]
pub fn external_sync_enabled() -> bool {
    REALTIME_INPUT
        .get()
        .is_some_and(|shared| shared.external_sync_enabled.load(Ordering::Acquire))
}

#[must_use]
pub fn stable_port_key(port_id: &str) -> u64 {
    port_id
        .as_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

#[derive(Debug, Clone, Copy)]
pub struct ShortMidiPacket {
    pub timestamp_micros: u64,
    pub bytes: [u8; 3],
    pub length: u8,
}

#[derive(Debug, Clone, Copy)]
struct SysExDescriptor {
    timestamp_micros: u64,
    length: u32,
}

struct CallbackState {
    timestamp_offset: Arc<AtomicI64>,
    short: HeapProd<ShortMidiPacket>,
    sysex_bytes: HeapProd<u8>,
    sysex_descriptors: HeapProd<SysExDescriptor>,
    dropped: Arc<AtomicU64>,
    panic_requested: Arc<AtomicBool>,
}

impl CallbackState {
    fn receive(&mut self, native_timestamp: u64, message: &[u8]) {
        let offset = self.timestamp_offset.load(Ordering::Acquire);
        let offset = if offset == i64::MIN {
            let shared = monotonic_micros();
            let calibrated = i64::try_from(shared)
                .unwrap_or(i64::MAX)
                .saturating_sub(i64::try_from(native_timestamp).unwrap_or(i64::MAX));
            self.timestamp_offset.store(calibrated, Ordering::Release);
            calibrated
        } else {
            offset
        };
        let timestamp_micros = native_timestamp.saturating_add_signed(offset);
        if message.len() <= 3 {
            let mut bytes = [0; 3];
            bytes[..message.len()].copy_from_slice(message);
            let packet = ShortMidiPacket {
                timestamp_micros,
                bytes,
                length: message.len() as u8,
            };
            if self.short.try_push(packet).is_err() {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                self.panic_requested.store(true, Ordering::Release);
            }
            return;
        }
        if message.len() > MIDI_MAX_SYSEX_BYTES
            || self.sysex_bytes.vacant_len() < message.len()
            || self.sysex_descriptors.is_full()
        {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        for byte in message {
            if self.sysex_bytes.try_push(*byte).is_err() {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
        let descriptor = SysExDescriptor {
            timestamp_micros,
            length: message.len() as u32,
        };
        if self.sysex_descriptors.try_push(descriptor).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

struct PortConnection {
    _connection: MidiInputConnection<CallbackState>,
    short: HeapCons<ShortMidiPacket>,
    sysex_bytes: HeapCons<u8>,
    sysex_descriptors: HeapCons<SysExDescriptor>,
    dropped: Arc<AtomicU64>,
    parser: MidiInputParser,
}

impl PortConnection {
    fn connect(port_id: &str, panic_requested: Arc<AtomicBool>) -> Result<Self, String> {
        let mut input = MidiInput::new("YADAW MIDI input").map_err(|error| error.to_string())?;
        input.ignore(Ignore::None);
        let port = input
            .find_port_by_id(port_id)
            .ok_or_else(|| format!("MIDI input `{port_id}` is missing"))?;
        let short_ring = HeapRb::<ShortMidiPacket>::new(MIDI_SHORT_QUEUE_CAPACITY);
        let (short, short_consumer) = short_ring.split();
        let byte_ring = HeapRb::<u8>::new(MIDI_SYSEX_SLAB_BYTES);
        let (sysex_bytes, sysex_byte_consumer) = byte_ring.split();
        let descriptor_ring = HeapRb::<SysExDescriptor>::new(SYSEX_DESCRIPTOR_CAPACITY);
        let (sysex_descriptors, sysex_descriptor_consumer) = descriptor_ring.split();
        let dropped = Arc::new(AtomicU64::new(0));
        let state = CallbackState {
            timestamp_offset: Arc::new(AtomicI64::new(i64::MIN)),
            short,
            sysex_bytes,
            sysex_descriptors,
            dropped: Arc::clone(&dropped),
            panic_requested,
        };
        let connection = input
            .connect(
                &port,
                "YADAW MIDI input",
                |timestamp, message, state| state.receive(timestamp, message),
                state,
            )
            .map_err(|error| error.to_string())?;
        Ok(Self {
            _connection: connection,
            short: short_consumer,
            sysex_bytes: sysex_byte_consumer,
            sysex_descriptors: sysex_descriptor_consumer,
            dropped,
            parser: MidiInputParser::default(),
        })
    }
}

enum Command {
    Configure(
        MidiSyncPreferences,
        mpsc::Sender<Result<MidiInputSnapshot, String>>,
    ),
    Routes {
        all_inputs: bool,
        port_ids: BTreeSet<String>,
    },
    Snapshot(mpsc::Sender<MidiInputSnapshot>),
    Shutdown,
}

pub struct MidiInputActor {
    sender: mpsc::Sender<Command>,
    thread: Option<thread::JoinHandle<()>>,
}

impl MidiInputActor {
    #[must_use]
    pub fn start(preferences: MidiSyncPreferences) -> Self {
        let (sender, receiver) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("yadaw-midi-input".to_owned())
            .spawn(move || run_actor(receiver, preferences))
            .ok();
        Self { sender, thread }
    }

    pub fn configure(&self, preferences: MidiSyncPreferences) -> Result<MidiInputSnapshot, String> {
        let (sender, receiver) = mpsc::channel();
        self.sender
            .send(Command::Configure(preferences, sender))
            .map_err(|_| "MIDI input actor is unavailable".to_owned())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "MIDI input configuration timed out".to_owned())?
    }

    pub fn update_routes(&self, all_inputs: bool, port_ids: BTreeSet<String>) {
        let _ = self.sender.send(Command::Routes {
            all_inputs,
            port_ids,
        });
    }

    #[must_use]
    pub fn snapshot(&self) -> MidiInputSnapshot {
        let (sender, receiver) = mpsc::channel();
        if self.sender.send(Command::Snapshot(sender)).is_err() {
            return unavailable_snapshot("MIDI input actor is unavailable");
        }
        receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|_| unavailable_snapshot("MIDI input snapshot timed out"))
    }
}

impl Drop for MidiInputActor {
    fn drop(&mut self) {
        let _ = self.sender.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct ActorState {
    preferences: MidiSyncPreferences,
    ports: Vec<WireMidiInputPort>,
    connections: BTreeMap<String, PortConnection>,
    route_port_ids: BTreeSet<String>,
    all_inputs: bool,
    clock: MidiClockSlave,
    ignored_system_messages: u64,
    error: Option<String>,
    realtime_events: Prod<Arc<HeapRb<RealtimeMidiEvent>>>,
    realtime_sysex: Prod<Arc<HeapRb<u8>>>,
    realtime_shared: Arc<RealtimeInputShared>,
    pending_events: Vec<PendingMidiEvent>,
    control_generation: u64,
    control_events: VecDeque<MidiControlEvent>,
}

struct PendingMidiEvent {
    timestamp_micros: u64,
    port_key: u64,
    message: MidiInputMessage,
}

fn run_actor(receiver: mpsc::Receiver<Command>, preferences: MidiSyncPreferences) {
    let realtime_shared = RealtimeInputShared::get();
    let mut state = ActorState {
        preferences,
        ports: Vec::new(),
        connections: BTreeMap::new(),
        route_port_ids: BTreeSet::new(),
        all_inputs: false,
        clock: MidiClockSlave::default(),
        ignored_system_messages: 0,
        error: None,
        realtime_events: Prod::new(Arc::clone(&realtime_shared.events)),
        realtime_sysex: Prod::new(Arc::clone(&realtime_shared.sysex)),
        realtime_shared,
        pending_events: Vec::with_capacity(MIDI_SHORT_QUEUE_CAPACITY),
        control_generation: 0,
        control_events: VecDeque::with_capacity(CONTROL_EVENT_CAPACITY),
    };
    state
        .realtime_shared
        .external_sync_enabled
        .store(state.preferences.enabled, Ordering::Release);
    state.clock.set_enabled(state.preferences.enabled);
    enumerate_and_reconcile(&mut state);
    let mut last_enumeration = Instant::now();
    loop {
        match receiver.recv_timeout(ACTOR_POLL_INTERVAL) {
            Ok(Command::Configure(preferences, reply)) => {
                if let Err(error) = validate_preferences(&preferences) {
                    let _ = reply.send(Err(error));
                    continue;
                }
                state.preferences = preferences;
                state
                    .realtime_shared
                    .external_sync_enabled
                    .store(state.preferences.enabled, Ordering::Release);
                state.clock.set_enabled(state.preferences.enabled);
                enumerate_and_reconcile(&mut state);
                let _ = reply.send(Ok(snapshot(&state)));
            }
            Ok(Command::Routes {
                all_inputs,
                port_ids,
            }) => {
                state.all_inputs = all_inputs;
                state.route_port_ids = port_ids;
                enumerate_and_reconcile(&mut state);
            }
            Ok(Command::Snapshot(reply)) => {
                let _ = reply.send(snapshot(&state));
            }
            Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if last_enumeration.elapsed() >= PORT_POLL_INTERVAL {
            enumerate_and_reconcile(&mut state);
            last_enumeration = Instant::now();
        }
        drain_connections(&mut state);
        flush_realtime_events(&mut state);
        let previous_clock_state = state.clock.snapshot().state;
        state.clock.advance(monotonic_micros());
        if previous_clock_state != MidiSyncState::Lost
            && state.clock.snapshot().state == MidiSyncState::Lost
        {
            state
                .realtime_shared
                .panic_requested
                .store(true, Ordering::Release);
            state
                .realtime_shared
                .sync_lost
                .store(true, Ordering::Release);
        }
    }
}

fn validate_preferences(preferences: &MidiSyncPreferences) -> Result<(), String> {
    if preferences.source_port_id.is_none() != preferences.source_port_name.is_none() {
        return Err("MIDI clock source ID and name must be set together".to_owned());
    }
    if preferences
        .input_offsets_ms
        .values()
        .any(|value| !value.is_finite() || !(-500.0..=500.0).contains(value))
    {
        return Err("MIDI timing offsets must be between -500 and 500 ms".to_owned());
    }
    Ok(())
}

fn enumerate_ports() -> Result<Vec<(MidiInputPort, WireMidiInputPort)>, String> {
    let input = MidiInput::new("YADAW MIDI enumeration").map_err(|error| error.to_string())?;
    Ok(input
        .ports()
        .into_iter()
        .filter_map(|port| {
            let name = input.port_name(&port).ok()?;
            Some((
                port.clone(),
                WireMidiInputPort {
                    id: port.id(),
                    name,
                    connected: true,
                },
            ))
        })
        .collect())
}

fn enumerate_and_reconcile(state: &mut ActorState) {
    let ports = match enumerate_ports() {
        Ok(ports) => ports,
        Err(error) => {
            state.error = Some(error);
            return;
        }
    };
    state.error = None;
    state.ports = ports.iter().map(|(_, port)| port.clone()).collect();
    let available: BTreeSet<_> = state.ports.iter().map(|port| port.id.clone()).collect();
    let mut wanted = state.route_port_ids.clone();
    if state.all_inputs {
        wanted.extend(available.iter().cloned());
    }
    if let Some(source) = &state.preferences.source_port_id {
        wanted.insert(source.clone());
    }
    wanted.extend(state.preferences.control_port_ids.iter().cloned());
    if state.preferences.capture_all_controls {
        wanted.extend(available.iter().cloned());
    }
    let disconnected = state
        .connections
        .keys()
        .any(|port_id| !wanted.contains(port_id) || !available.contains(port_id));
    state
        .connections
        .retain(|port_id, _| wanted.contains(port_id) && available.contains(port_id));
    if disconnected {
        state
            .realtime_shared
            .panic_requested
            .store(true, Ordering::Release);
    }
    for port_id in wanted.intersection(&available) {
        if !state.connections.contains_key(port_id) {
            match PortConnection::connect(
                port_id,
                Arc::clone(&state.realtime_shared.panic_requested),
            ) {
                Ok(connection) => {
                    state.connections.insert(port_id.clone(), connection);
                }
                Err(error) => state.error = Some(error),
            }
        }
    }
    if let (Some(id), Some(name)) = (
        &state.preferences.source_port_id,
        &state.preferences.source_port_name,
    ) && !available.contains(id)
    {
        state.ports.push(WireMidiInputPort {
            id: id.clone(),
            name: name.clone(),
            connected: false,
        });
    }
}

fn drain_connections(state: &mut ActorState) {
    let port_names: BTreeMap<_, _> = state
        .ports
        .iter()
        .map(|port| (port.id.clone(), port.name.clone()))
        .collect();
    for (port_id, connection) in &mut state.connections {
        let port_name = port_names
            .get(port_id)
            .map_or_else(|| port_id.as_str(), String::as_str);
        let offset_micros = state
            .preferences
            .input_offsets_ms
            .get(port_id)
            .copied()
            .unwrap_or(0.0)
            .mul_add(1_000.0, 0.0)
            .round() as i64;
        let port_key = stable_port_key(port_id);
        while let Some(packet) = connection.short.try_pop() {
            let message = &packet.bytes[..usize::from(packet.length)];
            if let Ok(messages) = connection.parser.push(message) {
                process_messages(
                    &mut MessageSink {
                        preferences: &state.preferences,
                        clock: &mut state.clock,
                        ignored_system_messages: &mut state.ignored_system_messages,
                        panic_requested: &state.realtime_shared.panic_requested,
                        pending_events: &mut state.pending_events,
                        control_generation: &mut state.control_generation,
                        control_events: &mut state.control_events,
                    },
                    port_id,
                    port_name,
                    port_key,
                    packet.timestamp_micros.saturating_add_signed(offset_micros),
                    messages,
                );
            }
        }
        while let Some(descriptor) = connection.sysex_descriptors.try_pop() {
            let mut bytes = Vec::with_capacity(descriptor.length as usize);
            for _ in 0..descriptor.length {
                let Some(byte) = connection.sysex_bytes.try_pop() else {
                    break;
                };
                bytes.push(byte);
            }
            if bytes.len() == descriptor.length as usize
                && let Ok(messages) = connection.parser.push(&bytes)
            {
                process_messages(
                    &mut MessageSink {
                        preferences: &state.preferences,
                        clock: &mut state.clock,
                        ignored_system_messages: &mut state.ignored_system_messages,
                        panic_requested: &state.realtime_shared.panic_requested,
                        pending_events: &mut state.pending_events,
                        control_generation: &mut state.control_generation,
                        control_events: &mut state.control_events,
                    },
                    port_id,
                    port_name,
                    port_key,
                    descriptor
                        .timestamp_micros
                        .saturating_add_signed(offset_micros),
                    messages,
                );
            }
        }
    }
}

struct MessageSink<'a> {
    preferences: &'a MidiSyncPreferences,
    clock: &'a mut MidiClockSlave,
    ignored_system_messages: &'a mut u64,
    panic_requested: &'a AtomicBool,
    pending_events: &'a mut Vec<PendingMidiEvent>,
    control_generation: &'a mut u64,
    control_events: &'a mut VecDeque<MidiControlEvent>,
}

fn process_messages(
    sink: &mut MessageSink<'_>,
    port_id: &str,
    port_name: &str,
    port_key: u64,
    timestamp_micros: u64,
    messages: Vec<MidiInputMessage>,
) {
    for message in messages {
        if sink.preferences.capture_all_controls
            || sink.preferences.control_port_ids.contains(port_id)
        {
            let kind = match &message {
                MidiInputMessage::NoteOn(_, number, value) if *value > 0 => {
                    Some(MidiControlEventKind::Note {
                        number: *number,
                        value: *value,
                    })
                }
                MidiInputMessage::ControlChange(_, number, value) => {
                    Some(MidiControlEventKind::ControlChange {
                        number: *number,
                        value: *value,
                    })
                }
                _ => None,
            };
            if let Some(kind) = kind {
                *sink.control_generation = (*sink.control_generation).saturating_add(1);
                if sink.control_events.len() == CONTROL_EVENT_CAPACITY {
                    sink.control_events.pop_front();
                }
                sink.control_events.push_back(MidiControlEvent {
                    generation: *sink.control_generation,
                    timestamp_microseconds: timestamp_micros,
                    port_id: port_id.to_owned(),
                    port_name: port_name.to_owned(),
                    channel: message.channel().unwrap_or(0),
                    kind,
                });
            }
        }
        let is_clock_source =
            sink.preferences.enabled && sink.preferences.source_port_id.as_deref() == Some(port_id);
        if is_clock_source {
            sink.clock.receive(&message, timestamp_micros);
            if matches!(
                message,
                MidiInputMessage::Clock
                    | MidiInputMessage::Start
                    | MidiInputMessage::Continue
                    | MidiInputMessage::Stop
                    | MidiInputMessage::SongPosition(_)
            ) {
                sink.pending_events.push(PendingMidiEvent {
                    timestamp_micros,
                    port_key,
                    message,
                });
                continue;
            }
        }
        if message.is_recordable() {
            sink.pending_events.push(PendingMidiEvent {
                timestamp_micros,
                port_key,
                message,
            });
            continue;
        }
        if matches!(message, MidiInputMessage::SystemReset) {
            sink.panic_requested.store(true, Ordering::Release);
        }
        if matches!(
            message,
            MidiInputMessage::ActiveSensing | MidiInputMessage::IgnoredSystem(_)
        ) {
            *sink.ignored_system_messages = sink.ignored_system_messages.saturating_add(1);
        }
    }
}

fn flush_realtime_events(state: &mut ActorState) {
    state
        .pending_events
        .sort_by_key(|event| event.timestamp_micros);
    let horizon = monotonic_micros().saturating_add(
        REALTIME_LOOKAHEAD
            .as_micros()
            .try_into()
            .unwrap_or(u64::MAX),
    );
    let ready = state
        .pending_events
        .partition_point(|event| event.timestamp_micros <= horizon);
    for event in state.pending_events.drain(..ready) {
        let channel = event.message.channel().unwrap_or(0);
        let message = match event.message {
            MidiInputMessage::NoteOff(_, key, velocity) => {
                RealtimeMidiMessage::NoteOff { key, velocity }
            }
            MidiInputMessage::NoteOn(_, key, velocity) => {
                RealtimeMidiMessage::NoteOn { key, velocity }
            }
            MidiInputMessage::PolyPressure(_, key, pressure) => {
                RealtimeMidiMessage::PolyPressure { key, pressure }
            }
            MidiInputMessage::ControlChange(_, controller, value) => {
                RealtimeMidiMessage::ControlChange { controller, value }
            }
            MidiInputMessage::ProgramChange(_, program) => {
                RealtimeMidiMessage::ProgramChange { program }
            }
            MidiInputMessage::ChannelPressure(_, pressure) => {
                RealtimeMidiMessage::ChannelPressure { pressure }
            }
            MidiInputMessage::PitchBend(_, value) => RealtimeMidiMessage::PitchBend { value },
            MidiInputMessage::SysEx(bytes) => {
                if state.realtime_events.is_full()
                    || state.realtime_sysex.vacant_len() < bytes.len()
                {
                    state
                        .realtime_shared
                        .dropped
                        .fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                for byte in &bytes {
                    if state.realtime_sysex.try_push(*byte).is_err() {
                        state
                            .realtime_shared
                            .dropped
                            .fetch_add(1, Ordering::Relaxed);
                        break;
                    }
                }
                RealtimeMidiMessage::SysEx {
                    length: bytes.len() as u32,
                }
            }
            MidiInputMessage::Clock => RealtimeMidiMessage::Clock {
                effective_bpm_bits: state
                    .clock
                    .snapshot()
                    .effective_bpm
                    .unwrap_or(f64::NAN)
                    .to_bits(),
            },
            MidiInputMessage::Start => RealtimeMidiMessage::Start,
            MidiInputMessage::Continue => RealtimeMidiMessage::Continue,
            MidiInputMessage::Stop => RealtimeMidiMessage::Stop,
            MidiInputMessage::SongPosition(position) => {
                RealtimeMidiMessage::SongPosition { position }
            }
            _ => continue,
        };
        let realtime = RealtimeMidiEvent {
            timestamp_micros: event.timestamp_micros,
            port_key: event.port_key,
            channel,
            message,
        };
        if state.realtime_events.try_push(realtime).is_err() {
            state
                .realtime_shared
                .dropped
                .fetch_add(1, Ordering::Relaxed);
            if matches!(
                realtime.message,
                RealtimeMidiMessage::NoteOn { .. } | RealtimeMidiMessage::NoteOff { .. }
            ) {
                state
                    .realtime_shared
                    .panic_requested
                    .store(true, Ordering::Release);
            }
        }
    }
}

fn snapshot(state: &ActorState) -> MidiInputSnapshot {
    let clock = state.clock.snapshot();
    let dropped_events = state
        .connections
        .values()
        .map(|connection| connection.dropped.load(Ordering::Relaxed))
        .sum::<u64>()
        .saturating_add(state.realtime_shared.dropped.load(Ordering::Relaxed));
    MidiInputSnapshot {
        ports: state.ports.clone(),
        sync: MidiSyncRuntime {
            state: match clock.state {
                MidiSyncState::Internal => "internal",
                MidiSyncState::Waiting => "waiting",
                MidiSyncState::Locking => "locking",
                MidiSyncState::Locked => "locked",
                MidiSyncState::Freewheel => "freewheel",
                MidiSyncState::Lost => "lost",
            }
            .to_owned(),
            source_port_id: state.preferences.source_port_id.clone(),
            source_port_name: state.preferences.source_port_name.clone(),
            effective_bpm: clock.effective_bpm,
            jitter_microseconds: clock.jitter_micros,
            last_clock_age_ms: None,
            dropped_events,
            ignored_system_messages: state.ignored_system_messages,
            error: state.error.clone(),
        },
        control_events: state.control_events.iter().cloned().collect(),
        captured_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    }
}

fn unavailable_snapshot(message: &str) -> MidiInputSnapshot {
    MidiInputSnapshot {
        ports: Vec::new(),
        sync: MidiSyncRuntime {
            state: "lost".to_owned(),
            source_port_id: None,
            source_port_name: None,
            effective_bpm: None,
            jitter_microseconds: 0.0,
            last_clock_age_ms: None,
            dropped_events: 0,
            ignored_system_messages: 0,
            error: Some(message.to_owned()),
        },
        control_events: Vec::new(),
        captured_at: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_out_of_range_timing_offsets() {
        assert!(
            validate_preferences(&MidiSyncPreferences {
                enabled: true,
                source_port_id: None,
                source_port_name: None,
                input_offsets_ms: BTreeMap::from([("port".to_owned(), 500.1)]),
                control_port_ids: BTreeSet::new(),
                capture_all_controls: false,
            })
            .is_err()
        );
    }

    #[test]
    fn captures_note_and_control_change_events_for_shortcut_ports() {
        let preferences = MidiSyncPreferences {
            enabled: false,
            source_port_id: None,
            source_port_name: None,
            input_offsets_ms: BTreeMap::new(),
            control_port_ids: BTreeSet::from(["controller".to_owned()]),
            capture_all_controls: false,
        };
        let mut clock = MidiClockSlave::default();
        let mut ignored = 0;
        let panic = AtomicBool::new(false);
        let mut pending = Vec::new();
        let mut generation = 0;
        let mut controls = VecDeque::new();
        process_messages(
            &mut MessageSink {
                preferences: &preferences,
                clock: &mut clock,
                ignored_system_messages: &mut ignored,
                panic_requested: &panic,
                pending_events: &mut pending,
                control_generation: &mut generation,
                control_events: &mut controls,
            },
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
    }
}
