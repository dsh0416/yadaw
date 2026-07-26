//! Cross-process transport primitives for the audio helper.
//!
//! MessagePack remains the logical protocol. Large immutable payloads travel as
//! `IpcSharedMemory` attachments, while fixed shared pages carry telemetry and
//! parameter commands. All pointer casting required by shared mappings is kept
//! in this crate.

use std::{
    collections::{HashMap, HashSet},
    mem::{align_of, size_of},
    sync::atomic::{AtomicU32, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use ipc_channel::ipc::{IpcReceiver, IpcSender, IpcSharedMemory};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use xxhash_rust::xxh3::xxh3_64;
use yadaw_dsp_runtime::protocol::{
    BinaryPayload, ControlCommand, ControlRequest, ControlResponse, ControlResult, GraphOp,
    GraphUpdate, HostEvent, INLINE_BLOB_LIMIT, MAX_MESSAGE_BYTES, MidiEventBatch, MidiNoteBatch,
    ParameterCommand, ParameterGesture, ParameterTargetKind, SharedBlobRef,
};

pub const MAX_OUTSTANDING_LEASES: usize = 256;
pub const MAX_OUTSTANDING_LEASE_BYTES: usize = 512 * 1024 * 1024;
pub const LEASE_TIMEOUT: Duration = Duration::from_secs(30);
pub const PARAMETER_RING_CAPACITY: u32 = 4096;
pub const PARAMETER_BOUNDARY_RESERVE: u64 = 64;
pub const INITIAL_TELEMETRY_CAPACITY: u32 = 64;

const TELEMETRY_MAGIC: u64 = 0x5941_4454_454C_4532;
const PARAMETER_MAGIC: u64 = 0x5941_4450_4152_4D32;
const SHARED_LAYOUT_VERSION: u64 = 1;
const HEADER_BYTES: usize = 128;
const METER_SLOT_BYTES: usize = 64;
const PARAMETER_SLOT_BYTES: usize = 64;

#[cfg(target_endian = "big")]
compile_error!("YADAW shared-page ABI currently supports little-endian targets only");

const _: () = assert!(HEADER_BYTES.is_multiple_of(align_of::<AtomicU64>()));
const _: () = assert!(METER_SLOT_BYTES.is_multiple_of(align_of::<AtomicU64>()));
const _: () = assert!(PARAMETER_SLOT_BYTES.is_multiple_of(align_of::<AtomicU64>()));

const OFFSET_MAGIC: usize = 0;
const OFFSET_LAYOUT_VERSION: usize = 8;
const OFFSET_EPOCH: usize = 16;
const OFFSET_CAPACITY: usize = 24;
const OFFSET_SEQUENCE: usize = 32;
const OFFSET_GRAPH_REVISION: usize = 40;
const OFFSET_CALLBACK_GENERATION: usize = 48;
const OFFSET_POSITION_FRAMES: usize = 56;
const OFFSET_SAMPLE_RATE: usize = 64;
const OFFSET_TRANSPORT_STATE: usize = 68;
const OFFSET_METER_COUNT: usize = 72;

const RING_OFFSET_HEAD: usize = 32;
const RING_OFFSET_TAIL: usize = 40;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("could not encode transport packet: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("could not decode transport packet: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
    #[error("transport packet exceeds 64 MiB")]
    MessageTooLarge,
    #[error("shared-memory lease capacity is exhausted")]
    LeaseCapacity,
    #[error("shared-memory lease identifier is already active")]
    DuplicateLease,
    #[error("shared blob references an unknown region")]
    UnknownRegion,
    #[error("shared blob range is invalid")]
    InvalidRange,
    #[error("shared blob checksum did not match")]
    ChecksumMismatch,
    #[error("shared page has an invalid layout")]
    InvalidSharedLayout,
    #[error("shared page capacity is invalid")]
    InvalidCapacity,
}

/// Outer value serialized by `ipc-channel`; shared-memory handles are carried
/// out of band by Servo's transport.
#[derive(Serialize, Deserialize)]
pub struct WirePacket {
    pub body: Vec<u8>,
    pub regions: Vec<IpcSharedMemory>,
}

/// Channels and persistent pages transferred during the one-shot rendezvous.
#[derive(Serialize, Deserialize)]
pub struct HostBootstrap {
    pub protocol_version: u16,
    pub requests: IpcReceiver<WirePacket>,
    pub responses: IpcSender<WirePacket>,
    pub priority_requests: IpcReceiver<WirePacket>,
    pub priority_responses: IpcSender<WirePacket>,
    pub events: IpcSender<WirePacket>,
    pub telemetry_page: IpcSharedMemory,
    pub parameter_ring: IpcSharedMemory,
    pub session_epoch: u64,
}

struct LeaseEntry {
    _memory: IpcSharedMemory,
    bytes: usize,
    created_at: Instant,
}

#[derive(Default)]
pub struct LeaseRegistry {
    next_id: u64,
    entries: HashMap<u64, LeaseEntry>,
    bytes: usize,
}

impl LeaseRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_id: 1,
            entries: HashMap::new(),
            bytes: 0,
        }
    }

    fn next_lease_id(&mut self) -> u64 {
        let id = self.next_id.max(1);
        self.next_id = id.wrapping_add(1).max(1);
        id
    }

    fn retain(&mut self, lease_id: u64, memory: IpcSharedMemory) -> Result<(), TransportError> {
        self.reap_expired();
        if self.entries.contains_key(&lease_id) {
            return Err(TransportError::DuplicateLease);
        }
        let bytes = memory.len();
        if self.entries.len() >= MAX_OUTSTANDING_LEASES
            || self.bytes.saturating_add(bytes) > MAX_OUTSTANDING_LEASE_BYTES
        {
            return Err(TransportError::LeaseCapacity);
        }
        self.bytes += bytes;
        self.entries.insert(
            lease_id,
            LeaseEntry {
                _memory: memory,
                bytes,
                created_at: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn release(&mut self, lease_ids: &[u64]) {
        for id in lease_ids {
            if let Some(entry) = self.entries.remove(id) {
                self.bytes = self.bytes.saturating_sub(entry.bytes);
            }
        }
    }

    pub fn reap_expired(&mut self) -> Vec<u64> {
        let now = Instant::now();
        let expired = self
            .entries
            .iter()
            .filter_map(|(id, entry)| {
                (now.duration_since(entry.created_at) >= LEASE_TIMEOUT).then_some(*id)
            })
            .collect::<Vec<_>>();
        self.release(&expired);
        expired
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

struct AttachmentBuilder {
    lease_id: u64,
    bytes: Vec<u8>,
}

impl AttachmentBuilder {
    fn new(lease_id: u64) -> Self {
        Self {
            lease_id,
            bytes: Vec::new(),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<SharedBlobRef, TransportError> {
        let aligned = self
            .bytes
            .len()
            .checked_add(7)
            .map(|value| value & !7)
            .ok_or(TransportError::MessageTooLarge)?;
        if aligned > self.bytes.len() {
            self.bytes.resize(aligned, 0);
        }
        let end = aligned
            .checked_add(bytes.len())
            .ok_or(TransportError::MessageTooLarge)?;
        if end > MAX_MESSAGE_BYTES {
            return Err(TransportError::MessageTooLarge);
        }
        self.bytes.extend_from_slice(bytes);
        Ok(SharedBlobRef {
            region: 0,
            offset: u64::try_from(aligned).map_err(|_| TransportError::MessageTooLarge)?,
            length: u64::try_from(bytes.len()).map_err(|_| TransportError::MessageTooLarge)?,
            checksum: xxh3_64(bytes),
            lease_id: self.lease_id,
        })
    }

    fn finish(self, registry: &mut LeaseRegistry) -> Result<Vec<IpcSharedMemory>, TransportError> {
        if self.bytes.is_empty() {
            return Ok(Vec::new());
        }
        let memory = IpcSharedMemory::from_bytes(&self.bytes);
        registry.retain(self.lease_id, memory.clone())?;
        Ok(vec![memory])
    }
}

fn externalize_binary(
    payload: &mut BinaryPayload,
    builder: &mut AttachmentBuilder,
) -> Result<(), TransportError> {
    let BinaryPayload::Inline { bytes } = payload else {
        return Ok(());
    };
    if bytes.len() <= INLINE_BLOB_LIMIT {
        return Ok(());
    }
    let reference = builder.push(bytes)?;
    *payload = BinaryPayload::Shared { reference };
    Ok(())
}

fn externalize_midi(
    batch: &mut MidiNoteBatch,
    builder: &mut AttachmentBuilder,
) -> Result<(), TransportError> {
    let MidiNoteBatch::Inline { notes } = batch else {
        return Ok(());
    };
    let encoded = rmp_serde::to_vec_named(notes)?;
    if encoded.len() <= INLINE_BLOB_LIMIT {
        return Ok(());
    }
    let reference = builder.push(&encoded)?;
    *batch = MidiNoteBatch::Shared { reference };
    Ok(())
}

fn externalize_midi_events(
    batch: &mut MidiEventBatch,
    builder: &mut AttachmentBuilder,
) -> Result<(), TransportError> {
    let MidiEventBatch::Inline { events } = batch else {
        return Ok(());
    };
    let encoded = rmp_serde::to_vec_named(events)?;
    if encoded.len() <= INLINE_BLOB_LIMIT {
        return Ok(());
    }
    let reference = builder.push(&encoded)?;
    *batch = MidiEventBatch::Shared { reference };
    Ok(())
}

fn visit_graph_update(
    update: &mut GraphUpdate,
    builder: &mut AttachmentBuilder,
) -> Result<(), TransportError> {
    match update {
        GraphUpdate::Replace { graph, .. } => {
            for clip in &mut graph.midi_clips {
                externalize_midi(&mut clip.notes, builder)?;
                externalize_midi_events(&mut clip.events, builder)?;
            }
        }
        GraphUpdate::Patch { ops, .. } => {
            for op in ops {
                if let GraphOp::UpsertMidiClip { value } = op {
                    externalize_midi(&mut value.notes, builder)?;
                    externalize_midi_events(&mut value.events, builder)?;
                }
            }
        }
    }
    Ok(())
}

pub fn encode_request(
    mut request: ControlRequest,
    leases: &mut LeaseRegistry,
) -> Result<WirePacket, TransportError> {
    let lease_id = leases.next_lease_id();
    let mut builder = AttachmentBuilder::new(lease_id);
    match &mut request.command {
        ControlCommand::BenchmarkEcho { payload } => {
            externalize_binary(payload, &mut builder)?;
        }
        ControlCommand::LoadPlugin {
            component_state,
            controller_state,
            ..
        } => {
            externalize_binary(component_state, &mut builder)?;
            externalize_binary(controller_state, &mut builder)?;
        }
        ControlCommand::UpdateGraph { update } => visit_graph_update(update, &mut builder)?,
        _ => {}
    }
    let body = encode_body(&request)?;
    let regions = builder.finish(leases)?;
    Ok(WirePacket { body, regions })
}

pub fn encode_response(
    mut response: ControlResponse,
    leases: &mut LeaseRegistry,
) -> Result<WirePacket, TransportError> {
    let lease_id = leases.next_lease_id();
    let mut builder = AttachmentBuilder::new(lease_id);
    match &mut response.result {
        ControlResult::BenchmarkEcho { payload } => {
            externalize_binary(payload, &mut builder)?;
        }
        ControlResult::RecordingWaveform { waveform } => {
            externalize_binary(&mut waveform.peaks, &mut builder)?;
        }
        ControlResult::PluginState {
            component_state,
            controller_state,
        } => {
            externalize_binary(component_state, &mut builder)?;
            externalize_binary(controller_state, &mut builder)?;
        }
        _ => {}
    }
    let body = encode_body(&response)?;
    let regions = builder.finish(leases)?;
    Ok(WirePacket { body, regions })
}

pub fn encode_priority<T: Serialize>(value: &T) -> Result<WirePacket, TransportError> {
    Ok(WirePacket {
        body: encode_body(value)?,
        regions: Vec::new(),
    })
}

pub fn encode_event(
    event: &HostEvent,
    regions: Vec<IpcSharedMemory>,
) -> Result<WirePacket, TransportError> {
    Ok(WirePacket {
        body: encode_body(event)?,
        regions,
    })
}

pub fn decode_request(packet: WirePacket) -> Result<(ControlRequest, Vec<u64>), TransportError> {
    let mut request: ControlRequest = decode_body(&packet.body)?;
    let mut leases = HashSet::new();
    match &mut request.command {
        ControlCommand::BenchmarkEcho { payload } => {
            materialize_binary(payload, &packet.regions, &mut leases)?;
        }
        ControlCommand::LoadPlugin {
            component_state,
            controller_state,
            ..
        } => {
            materialize_binary(component_state, &packet.regions, &mut leases)?;
            materialize_binary(controller_state, &packet.regions, &mut leases)?;
        }
        ControlCommand::UpdateGraph { update } => {
            materialize_graph_update(update, &packet.regions, &mut leases)?;
        }
        _ => {}
    }
    Ok((request, leases.into_iter().collect()))
}

pub fn decode_response(packet: WirePacket) -> Result<(ControlResponse, Vec<u64>), TransportError> {
    let mut response: ControlResponse = decode_body(&packet.body)?;
    let mut leases = HashSet::new();
    match &mut response.result {
        ControlResult::BenchmarkEcho { payload } => {
            materialize_binary(payload, &packet.regions, &mut leases)?;
        }
        ControlResult::RecordingWaveform { waveform } => {
            materialize_binary(&mut waveform.peaks, &packet.regions, &mut leases)?;
        }
        ControlResult::PluginState {
            component_state,
            controller_state,
        } => {
            materialize_binary(component_state, &packet.regions, &mut leases)?;
            materialize_binary(controller_state, &packet.regions, &mut leases)?;
        }
        _ => {}
    }
    Ok((response, leases.into_iter().collect()))
}

pub fn decode_body<T: DeserializeOwned>(body: &[u8]) -> Result<T, TransportError> {
    if body.len() > MAX_MESSAGE_BYTES {
        return Err(TransportError::MessageTooLarge);
    }
    Ok(rmp_serde::from_slice(body)?)
}

pub fn encode_body<T: Serialize>(value: &T) -> Result<Vec<u8>, TransportError> {
    let body = rmp_serde::to_vec_named(value)?;
    if body.len() > MAX_MESSAGE_BYTES {
        return Err(TransportError::MessageTooLarge);
    }
    Ok(body)
}

fn shared_bytes(
    reference: SharedBlobRef,
    regions: &[IpcSharedMemory],
) -> Result<&[u8], TransportError> {
    let region = regions
        .get(usize::from(reference.region))
        .ok_or(TransportError::UnknownRegion)?;
    let offset = usize::try_from(reference.offset).map_err(|_| TransportError::InvalidRange)?;
    let length = usize::try_from(reference.length).map_err(|_| TransportError::InvalidRange)?;
    let end = offset
        .checked_add(length)
        .ok_or(TransportError::InvalidRange)?;
    let bytes = region
        .get(offset..end)
        .ok_or(TransportError::InvalidRange)?;
    if xxh3_64(bytes) != reference.checksum {
        return Err(TransportError::ChecksumMismatch);
    }
    Ok(bytes)
}

fn materialize_binary(
    payload: &mut BinaryPayload,
    regions: &[IpcSharedMemory],
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    let BinaryPayload::Shared { reference } = payload else {
        return Ok(());
    };
    let bytes = shared_bytes(*reference, regions)?.to_vec();
    leases.insert(reference.lease_id);
    *payload = BinaryPayload::Inline { bytes };
    Ok(())
}

fn materialize_midi(
    batch: &mut MidiNoteBatch,
    regions: &[IpcSharedMemory],
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    let MidiNoteBatch::Shared { reference } = batch else {
        return Ok(());
    };
    let notes = rmp_serde::from_slice(shared_bytes(*reference, regions)?)?;
    leases.insert(reference.lease_id);
    *batch = MidiNoteBatch::Inline { notes };
    Ok(())
}

fn materialize_midi_events(
    batch: &mut MidiEventBatch,
    regions: &[IpcSharedMemory],
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    let MidiEventBatch::Shared { reference } = batch else {
        return Ok(());
    };
    let events = rmp_serde::from_slice(shared_bytes(*reference, regions)?)?;
    leases.insert(reference.lease_id);
    *batch = MidiEventBatch::Inline { events };
    Ok(())
}

fn materialize_graph_update(
    update: &mut GraphUpdate,
    regions: &[IpcSharedMemory],
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    match update {
        GraphUpdate::Replace { graph, .. } => {
            for clip in &mut graph.midi_clips {
                materialize_midi(&mut clip.notes, regions, leases)?;
                materialize_midi_events(&mut clip.events, regions, leases)?;
            }
        }
        GraphUpdate::Patch { ops, .. } => {
            for op in ops {
                if let GraphOp::UpsertMidiClip { value } = op {
                    materialize_midi(&mut value.notes, regions, leases)?;
                    materialize_midi_events(&mut value.events, regions, leases)?;
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TelemetryMeter {
    pub runtime_handle: u32,
    pub pre_left: f32,
    pub pre_right: f32,
    pub post_left: f32,
    pub post_right: f32,
    pub held_left: f32,
    pub held_right: f32,
    pub clipped: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TelemetrySnapshot {
    pub epoch: u64,
    pub graph_revision: u64,
    pub callback_generation: u64,
    pub transport_state: u32,
    pub position_frames: i64,
    pub sample_rate: u32,
    pub meters: Vec<TelemetryMeter>,
}

pub fn create_telemetry_page(capacity: u32, epoch: u64) -> Result<IpcSharedMemory, TransportError> {
    let capacity = capacity
        .max(INITIAL_TELEMETRY_CAPACITY)
        .checked_next_power_of_two()
        .ok_or(TransportError::InvalidCapacity)?;
    let length = page_length(capacity, METER_SLOT_BYTES)?;
    let memory = IpcSharedMemory::from_byte(0, length);
    let page = AtomicPage::new(&memory);
    page.store_u64(OFFSET_MAGIC, TELEMETRY_MAGIC, Ordering::Relaxed);
    page.store_u64(
        OFFSET_LAYOUT_VERSION,
        SHARED_LAYOUT_VERSION,
        Ordering::Relaxed,
    );
    page.store_u64(OFFSET_EPOCH, epoch, Ordering::Relaxed);
    page.store_u64(OFFSET_CAPACITY, u64::from(capacity), Ordering::Release);
    Ok(memory)
}

pub struct TelemetryWriter {
    memory: IpcSharedMemory,
    capacity: u32,
    epoch: u64,
}

impl TelemetryWriter {
    pub fn map(memory: IpcSharedMemory) -> Result<Self, TransportError> {
        let page = AtomicPage::new(&memory);
        validate_page(&page, TELEMETRY_MAGIC, METER_SLOT_BYTES)?;
        let capacity = u32::try_from(page.load_u64(OFFSET_CAPACITY, Ordering::Acquire))
            .map_err(|_| TransportError::InvalidCapacity)?;
        let epoch = page.load_u64(OFFSET_EPOCH, Ordering::Acquire);
        Ok(Self {
            memory,
            capacity,
            epoch,
        })
    }

    #[must_use]
    pub fn capacity(&self) -> u32 {
        self.capacity
    }

    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn publish(&self, snapshot: &TelemetrySnapshot) -> Result<(), TransportError> {
        if snapshot.meters.len()
            > usize::try_from(self.capacity).map_err(|_| TransportError::InvalidCapacity)?
        {
            return Err(TransportError::InvalidCapacity);
        }
        let page = AtomicPage::new(&self.memory);
        page.fetch_add_u64(OFFSET_SEQUENCE, 1, Ordering::AcqRel);
        page.store_u64(
            OFFSET_GRAPH_REVISION,
            snapshot.graph_revision,
            Ordering::Relaxed,
        );
        page.store_u64(
            OFFSET_CALLBACK_GENERATION,
            snapshot.callback_generation,
            Ordering::Relaxed,
        );
        page.store_u64(
            OFFSET_POSITION_FRAMES,
            u64::from_ne_bytes(snapshot.position_frames.to_ne_bytes()),
            Ordering::Relaxed,
        );
        page.store_u32(OFFSET_SAMPLE_RATE, snapshot.sample_rate, Ordering::Relaxed);
        page.store_u32(
            OFFSET_TRANSPORT_STATE,
            snapshot.transport_state,
            Ordering::Relaxed,
        );
        page.store_u32(
            OFFSET_METER_COUNT,
            u32::try_from(snapshot.meters.len()).map_err(|_| TransportError::InvalidCapacity)?,
            Ordering::Relaxed,
        );
        for (index, meter) in snapshot.meters.iter().enumerate() {
            write_meter(&page, index, *meter);
        }
        page.fetch_add_u64(OFFSET_SEQUENCE, 1, Ordering::Release);
        Ok(())
    }
}

pub struct TelemetryReader {
    memory: IpcSharedMemory,
    capacity: u32,
    epoch: u64,
}

impl TelemetryReader {
    pub fn map(memory: IpcSharedMemory) -> Result<Self, TransportError> {
        let page = AtomicPage::new(&memory);
        validate_page(&page, TELEMETRY_MAGIC, METER_SLOT_BYTES)?;
        let capacity = u32::try_from(page.load_u64(OFFSET_CAPACITY, Ordering::Acquire))
            .map_err(|_| TransportError::InvalidCapacity)?;
        let epoch = page.load_u64(OFFSET_EPOCH, Ordering::Acquire);
        Ok(Self {
            memory,
            capacity,
            epoch,
        })
    }

    pub fn read(&self) -> Option<TelemetrySnapshot> {
        let page = AtomicPage::new(&self.memory);
        for _ in 0..8 {
            let before = page.load_u64(OFFSET_SEQUENCE, Ordering::Acquire);
            if before & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            let meter_count = page
                .load_u32(OFFSET_METER_COUNT, Ordering::Relaxed)
                .min(self.capacity);
            let mut meters = Vec::with_capacity(meter_count as usize);
            for index in 0..meter_count as usize {
                meters.push(read_meter(&page, index));
            }
            let snapshot = TelemetrySnapshot {
                epoch: self.epoch,
                graph_revision: page.load_u64(OFFSET_GRAPH_REVISION, Ordering::Relaxed),
                callback_generation: page.load_u64(OFFSET_CALLBACK_GENERATION, Ordering::Relaxed),
                transport_state: page.load_u32(OFFSET_TRANSPORT_STATE, Ordering::Relaxed),
                position_frames: i64::from_ne_bytes(
                    page.load_u64(OFFSET_POSITION_FRAMES, Ordering::Relaxed)
                        .to_ne_bytes(),
                ),
                sample_rate: page.load_u32(OFFSET_SAMPLE_RATE, Ordering::Relaxed),
                meters,
            };
            let after = page.load_u64(OFFSET_SEQUENCE, Ordering::Acquire);
            if before == after && after & 1 == 0 {
                return Some(snapshot);
            }
        }
        None
    }

    #[must_use]
    pub fn capacity(&self) -> u32 {
        self.capacity
    }

    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

pub fn create_parameter_ring(epoch: u64) -> Result<IpcSharedMemory, TransportError> {
    let length = page_length(PARAMETER_RING_CAPACITY, PARAMETER_SLOT_BYTES)?;
    let memory = IpcSharedMemory::from_byte(0, length);
    let page = AtomicPage::new(&memory);
    page.store_u64(OFFSET_MAGIC, PARAMETER_MAGIC, Ordering::Relaxed);
    page.store_u64(
        OFFSET_LAYOUT_VERSION,
        SHARED_LAYOUT_VERSION,
        Ordering::Relaxed,
    );
    page.store_u64(OFFSET_EPOCH, epoch, Ordering::Relaxed);
    page.store_u64(
        OFFSET_CAPACITY,
        u64::from(PARAMETER_RING_CAPACITY),
        Ordering::Release,
    );
    Ok(memory)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParameterEnqueue {
    Queued { wake: bool },
    SoftFull,
    Full,
    StaleEpoch,
}

pub struct ParameterProducer {
    memory: IpcSharedMemory,
    capacity: u64,
    epoch: u64,
}

impl ParameterProducer {
    pub fn map(memory: IpcSharedMemory) -> Result<Self, TransportError> {
        let page = AtomicPage::new(&memory);
        validate_page(&page, PARAMETER_MAGIC, PARAMETER_SLOT_BYTES)?;
        Ok(Self {
            capacity: page.load_u64(OFFSET_CAPACITY, Ordering::Acquire),
            epoch: page.load_u64(OFFSET_EPOCH, Ordering::Acquire),
            memory,
        })
    }

    pub fn enqueue(&self, command: ParameterCommand) -> ParameterEnqueue {
        if command.session_epoch != self.epoch {
            return ParameterEnqueue::StaleEpoch;
        }
        let page = AtomicPage::new(&self.memory);
        let head = page.load_u64(RING_OFFSET_HEAD, Ordering::Relaxed);
        let tail = page.load_u64(RING_OFFSET_TAIL, Ordering::Acquire);
        let used = head.saturating_sub(tail);
        let free = self.capacity.saturating_sub(used);
        if free == 0 {
            return ParameterEnqueue::Full;
        }
        if command.gesture == ParameterGesture::Perform && free <= PARAMETER_BOUNDARY_RESERVE {
            return ParameterEnqueue::SoftFull;
        }
        write_parameter(&page, (head % self.capacity) as usize, command);
        page.store_u64(RING_OFFSET_HEAD, head.wrapping_add(1), Ordering::Release);
        ParameterEnqueue::Queued { wake: head == tail }
    }

    #[must_use]
    pub fn usage(&self) -> (u64, u64) {
        let page = AtomicPage::new(&self.memory);
        let head = page.load_u64(RING_OFFSET_HEAD, Ordering::Acquire);
        let tail = page.load_u64(RING_OFFSET_TAIL, Ordering::Acquire);
        (head.saturating_sub(tail).min(self.capacity), self.capacity)
    }
}

pub struct ParameterConsumer {
    memory: IpcSharedMemory,
    capacity: u64,
    epoch: u64,
}

impl ParameterConsumer {
    pub fn map(memory: IpcSharedMemory) -> Result<Self, TransportError> {
        let page = AtomicPage::new(&memory);
        validate_page(&page, PARAMETER_MAGIC, PARAMETER_SLOT_BYTES)?;
        Ok(Self {
            capacity: page.load_u64(OFFSET_CAPACITY, Ordering::Acquire),
            epoch: page.load_u64(OFFSET_EPOCH, Ordering::Acquire),
            memory,
        })
    }

    pub fn drain(&self, limit: usize, target: &mut Vec<ParameterCommand>) {
        let page = AtomicPage::new(&self.memory);
        let mut tail = page.load_u64(RING_OFFSET_TAIL, Ordering::Relaxed);
        let head = page.load_u64(RING_OFFSET_HEAD, Ordering::Acquire);
        let available = head.saturating_sub(tail).min(limit as u64);
        target.reserve(available as usize);
        for _ in 0..available {
            let command = read_parameter(&page, (tail % self.capacity) as usize);
            if command.session_epoch == self.epoch {
                target.push(command);
            }
            tail = tail.wrapping_add(1);
        }
        page.store_u64(RING_OFFSET_TAIL, tail, Ordering::Release);
    }
}

fn page_length(capacity: u32, slot_bytes: usize) -> Result<usize, TransportError> {
    usize::try_from(capacity)
        .ok()
        .and_then(|value| value.checked_mul(slot_bytes))
        .and_then(|slots| HEADER_BYTES.checked_add(slots))
        .filter(|length| *length <= MAX_MESSAGE_BYTES)
        .ok_or(TransportError::InvalidCapacity)
}

fn validate_page(
    page: &AtomicPage<'_>,
    magic: u64,
    slot_bytes: usize,
) -> Result<(), TransportError> {
    if page.len() < HEADER_BYTES {
        return Err(TransportError::InvalidSharedLayout);
    }
    if page.load_u64(OFFSET_MAGIC, Ordering::Acquire) != magic
        || page.load_u64(OFFSET_LAYOUT_VERSION, Ordering::Acquire) != SHARED_LAYOUT_VERSION
    {
        return Err(TransportError::InvalidSharedLayout);
    }
    let capacity = u32::try_from(page.load_u64(OFFSET_CAPACITY, Ordering::Acquire))
        .map_err(|_| TransportError::InvalidCapacity)?;
    let expected = page_length(capacity, slot_bytes)?;
    if page.len() != expected {
        return Err(TransportError::InvalidSharedLayout);
    }
    Ok(())
}

fn meter_offset(index: usize) -> usize {
    HEADER_BYTES + index * METER_SLOT_BYTES
}

fn write_meter(page: &AtomicPage<'_>, index: usize, meter: TelemetryMeter) {
    let offset = meter_offset(index);
    page.store_u32(offset, meter.runtime_handle, Ordering::Relaxed);
    for (slot, value) in [
        meter.pre_left,
        meter.pre_right,
        meter.post_left,
        meter.post_right,
        meter.held_left,
        meter.held_right,
    ]
    .into_iter()
    .enumerate()
    {
        page.store_u32(offset + 4 + slot * 4, value.to_bits(), Ordering::Relaxed);
    }
    page.store_u32(offset + 28, u32::from(meter.clipped), Ordering::Relaxed);
}

fn read_meter(page: &AtomicPage<'_>, index: usize) -> TelemetryMeter {
    let offset = meter_offset(index);
    let value =
        |slot: usize| f32::from_bits(page.load_u32(offset + 4 + slot * 4, Ordering::Relaxed));
    TelemetryMeter {
        runtime_handle: page.load_u32(offset, Ordering::Relaxed),
        pre_left: value(0),
        pre_right: value(1),
        post_left: value(2),
        post_right: value(3),
        held_left: value(4),
        held_right: value(5),
        clipped: page.load_u32(offset + 28, Ordering::Relaxed) != 0,
    }
}

fn parameter_offset(index: usize) -> usize {
    HEADER_BYTES + index * PARAMETER_SLOT_BYTES
}

fn write_parameter(page: &AtomicPage<'_>, index: usize, command: ParameterCommand) {
    let offset = parameter_offset(index);
    page.store_u64(offset, command.session_epoch, Ordering::Relaxed);
    page.store_u64(offset + 8, command.sequence, Ordering::Relaxed);
    page.store_u32(offset + 16, command.target_kind as u32, Ordering::Relaxed);
    page.store_u32(offset + 20, command.runtime_handle, Ordering::Relaxed);
    page.store_u32(offset + 24, command.parameter_id, Ordering::Relaxed);
    page.store_u32(
        offset + 28,
        gesture_to_u32(command.gesture),
        Ordering::Relaxed,
    );
    page.store_u64(offset + 32, command.normalized.to_bits(), Ordering::Relaxed);
}

fn read_parameter(page: &AtomicPage<'_>, index: usize) -> ParameterCommand {
    let offset = parameter_offset(index);
    ParameterCommand {
        session_epoch: page.load_u64(offset, Ordering::Relaxed),
        sequence: page.load_u64(offset + 8, Ordering::Relaxed),
        target_kind: match page.load_u32(offset + 16, Ordering::Relaxed) {
            2 => ParameterTargetKind::MixerChannel,
            3 => ParameterTargetKind::MixerSend,
            _ => ParameterTargetKind::Plugin,
        },
        runtime_handle: page.load_u32(offset + 20, Ordering::Relaxed),
        parameter_id: page.load_u32(offset + 24, Ordering::Relaxed),
        normalized: f64::from_bits(page.load_u64(offset + 32, Ordering::Relaxed)),
        gesture: match page.load_u32(offset + 28, Ordering::Relaxed) {
            1 => ParameterGesture::Begin,
            3 => ParameterGesture::End,
            _ => ParameterGesture::Perform,
        },
    }
}

const fn gesture_to_u32(gesture: ParameterGesture) -> u32 {
    match gesture {
        ParameterGesture::Begin => 1,
        ParameterGesture::Perform => 2,
        ParameterGesture::End => 3,
    }
}

struct AtomicPage<'a> {
    bytes: &'a [u8],
}

impl<'a> AtomicPage<'a> {
    fn new(memory: &'a IpcSharedMemory) -> Self {
        Self { bytes: memory }
    }

    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn atomic_u32(&self, offset: usize) -> &AtomicU32 {
        debug_assert_eq!(offset % align_of::<AtomicU32>(), 0);
        debug_assert!(offset + size_of::<AtomicU32>() <= self.bytes.len());
        // SAFETY: IpcSharedMemory mappings are page-aligned and remain alive for
        // this borrow. Every shared field is naturally aligned and is accessed
        // exclusively through the matching atomic type in both processes.
        unsafe { &*self.bytes.as_ptr().add(offset).cast::<AtomicU32>() }
    }

    fn atomic_u64(&self, offset: usize) -> &AtomicU64 {
        debug_assert_eq!(offset % align_of::<AtomicU64>(), 0);
        debug_assert!(offset + size_of::<AtomicU64>() <= self.bytes.len());
        // SAFETY: See `atomic_u32`; the fixed ABI guarantees 64-bit alignment.
        unsafe { &*self.bytes.as_ptr().add(offset).cast::<AtomicU64>() }
    }

    fn load_u32(&self, offset: usize, ordering: Ordering) -> u32 {
        self.atomic_u32(offset).load(ordering)
    }

    fn store_u32(&self, offset: usize, value: u32, ordering: Ordering) {
        self.atomic_u32(offset).store(value, ordering);
    }

    fn load_u64(&self, offset: usize, ordering: Ordering) -> u64 {
        self.atomic_u64(offset).load(ordering)
    }

    fn store_u64(&self, offset: usize, value: u64, ordering: Ordering) {
        self.atomic_u64(offset).store(value, ordering);
    }

    fn fetch_add_u64(&self, offset: usize, value: u64, ordering: Ordering) -> u64 {
        self.atomic_u64(offset).fetch_add(value, ordering)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yadaw_dsp_runtime::protocol::{
        ControlCommand, ControlRequest, GraphUpdate, LiveMidiClip, LiveMidiEvent, LiveMixerGraph,
        LiveTempoEvent, LiveTimeSignatureEvent, MidiEventBatch, MidiNoteBatch, PROTOCOL_VERSION,
        RecordingWaveform,
    };

    #[test]
    fn payload_at_threshold_stays_inline_and_larger_payload_uses_shared_memory() {
        let request = |size| ControlRequest {
            version: PROTOCOL_VERSION,
            request_id: size as u64,
            command: ControlCommand::LoadPlugin {
                instance_id: "plugin".into(),
                module_path: "fixture.vst3".into(),
                class_id: "fixture".into(),
                sample_rate: 48_000.0,
                component_state: BinaryPayload::inline(vec![7; size]),
                controller_state: BinaryPayload::inline(Vec::new()),
            },
        };
        let mut leases = LeaseRegistry::new();
        let inline = encode_request(request(INLINE_BLOB_LIMIT), &mut leases).unwrap();
        assert!(inline.regions.is_empty());
        let shared = encode_request(request(INLINE_BLOB_LIMIT + 1), &mut leases).unwrap();
        assert_eq!(shared.regions.len(), 1);
        let (decoded, release) = decode_request(shared).unwrap();
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
            version: PROTOCOL_VERSION,
            request_id: 42,
            command: ControlCommand::BenchmarkEcho {
                payload: BinaryPayload::inline(payload.clone()),
            },
        };
        let mut request_leases = LeaseRegistry::new();
        let request_packet = encode_request(request, &mut request_leases).unwrap();
        assert_eq!(request_packet.regions.len(), 1);
        let (decoded, release) = decode_request(request_packet).unwrap();
        assert_eq!(release.len(), 1);
        let ControlCommand::BenchmarkEcho {
            payload: decoded_payload,
        } = decoded.command
        else {
            panic!("wrong benchmark command");
        };
        assert_eq!(decoded_payload.as_inline(), Some(payload.as_slice()));

        let response = ControlResponse {
            version: PROTOCOL_VERSION,
            request_id: 42,
            result: ControlResult::BenchmarkEcho {
                payload: decoded_payload,
            },
        };
        let mut response_leases = LeaseRegistry::new();
        let response_packet = encode_response(response, &mut response_leases).unwrap();
        assert_eq!(response_packet.regions.len(), 1);
        let (decoded, release) = decode_response(response_packet).unwrap();
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
    fn multiple_large_fields_share_one_aligned_region_and_one_lease() {
        let request = ControlRequest {
            version: PROTOCOL_VERSION,
            request_id: 4,
            command: ControlCommand::LoadPlugin {
                instance_id: "plugin".into(),
                module_path: "fixture.vst3".into(),
                class_id: "fixture".into(),
                sample_rate: 48_000.0,
                component_state: BinaryPayload::inline(vec![1; INLINE_BLOB_LIMIT + 3]),
                controller_state: BinaryPayload::inline(vec![2; INLINE_BLOB_LIMIT + 5]),
            },
        };
        let mut leases = LeaseRegistry::new();
        let packet = encode_request(request, &mut leases).unwrap();
        assert_eq!(packet.regions.len(), 1);
        let wire = decode_body::<ControlRequest>(&packet.body).unwrap();
        let ControlCommand::LoadPlugin {
            component_state:
                BinaryPayload::Shared {
                    reference: component,
                },
            controller_state:
                BinaryPayload::Shared {
                    reference: controller,
                },
            ..
        } = wire.command
        else {
            panic!("large plugin states were not externalized");
        };
        assert_eq!(component.region, 0);
        assert_eq!(controller.region, 0);
        assert_eq!(component.offset % 8, 0);
        assert_eq!(controller.offset % 8, 0);
        assert_eq!(component.lease_id, controller.lease_id);
        let (decoded, release) = decode_request(packet).unwrap();
        assert_eq!(release, vec![component.lease_id]);
        let ControlCommand::LoadPlugin {
            component_state,
            controller_state,
            ..
        } = decoded.command
        else {
            panic!("wrong decoded command");
        };
        assert_eq!(component_state.as_inline().unwrap()[0], 1);
        assert_eq!(controller_state.as_inline().unwrap()[0], 2);
    }

    #[test]
    fn large_midi_sysex_batch_uses_and_restores_a_shared_attachment() {
        let request = ControlRequest {
            version: PROTOCOL_VERSION,
            request_id: 5,
            command: ControlCommand::UpdateGraph {
                update: GraphUpdate::Replace {
                    revision: 1,
                    graph: LiveMixerGraph {
                        sample_rate: 48_000,
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
        assert_eq!(packet.regions.len(), 1);
        let (decoded, release) = decode_request(packet).unwrap();
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
    fn invalid_shared_range_and_duplicate_lease_are_rejected() {
        let response = ControlResponse {
            version: PROTOCOL_VERSION,
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
        assert!(matches!(
            decode_response(packet),
            Err(TransportError::InvalidRange)
        ));

        let memory = IpcSharedMemory::from_bytes(&[1, 2, 3]);
        let mut registry = LeaseRegistry::new();
        registry.retain(7, memory.clone()).unwrap();
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.bytes(), 3);
        assert!(matches!(
            registry.retain(7, memory),
            Err(TransportError::DuplicateLease)
        ));
        registry.release(&[7]);
        assert_eq!(registry.bytes(), 0);
    }

    #[test]
    fn checksum_mismatch_is_rejected() {
        let response = ControlResponse {
            version: 2,
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
        reference.checksum ^= 1;
        waveform.peaks = BinaryPayload::Shared { reference };
        packet.body = encode_body(&ControlResponse {
            version: 2,
            request_id: 1,
            result: ControlResult::RecordingWaveform { waveform },
        })
        .unwrap();
        assert!(matches!(
            decode_response(packet),
            Err(TransportError::ChecksumMismatch)
        ));
    }

    #[test]
    fn telemetry_snapshot_is_coherent() {
        let memory = create_telemetry_page(64, 9).unwrap();
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
        let memory = create_telemetry_page(65, 11).unwrap();
        let writer = TelemetryWriter::map(memory).unwrap();
        assert_eq!(writer.capacity(), 128);
        assert_eq!(writer.epoch(), 11);
    }

    #[test]
    fn short_persistent_page_is_rejected_before_atomic_access() {
        let memory = IpcSharedMemory::from_bytes(&[0; 8]);
        assert!(matches!(
            TelemetryReader::map(memory),
            Err(TransportError::InvalidSharedLayout)
        ));
    }

    #[test]
    fn parameter_ring_reserves_gesture_boundaries() {
        let memory = create_parameter_ring(3).unwrap();
        let producer = ParameterProducer::map(memory.clone()).unwrap();
        let consumer = ParameterConsumer::map(memory).unwrap();
        let command = |sequence, gesture| ParameterCommand {
            session_epoch: 3,
            sequence,
            target_kind: ParameterTargetKind::Plugin,
            runtime_handle: 2,
            parameter_id: 8,
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
        let memory = create_parameter_ring(3).unwrap();
        let producer = ParameterProducer::map(memory.clone()).unwrap();
        let consumer = ParameterConsumer::map(memory).unwrap();
        let stale = ParameterCommand {
            session_epoch: 2,
            sequence: 1,
            target_kind: ParameterTargetKind::Plugin,
            runtime_handle: 2,
            parameter_id: 8,
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
}
