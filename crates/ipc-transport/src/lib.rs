//! Cross-process transport primitives for the audio helper.
//!
//! MessagePack remains the logical protocol. Large immutable payloads travel as
//! `IpcSharedMemory` attachments, while fixed shared pages carry telemetry and
//! parameter commands. All pointer casting required by shared mappings is kept
//! in this crate.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    mem::{align_of, size_of},
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use ipc_channel::ipc::{IpcReceiver, IpcSender, IpcSharedMemory};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use yadaw_dsp_runtime::protocol::{
    BinaryPayload, ControlCommand, ControlRequest, ControlResponse, ControlResult, GraphOp,
    GraphUpdate, HostEvent, INLINE_BLOB_LIMIT, LiveMidiEvent, LiveMidiNote, LiveMixerGraph,
    MAX_MESSAGE_BYTES, MidiEventBatch, MidiNoteBatch, ParameterCommand, ParameterGesture,
    ParameterTargetKind, SharedBlobRef,
};
use zerocopy::{
    FromBytes, Immutable, IntoBytes, KnownLayout, Unaligned,
    byteorder::little_endian::{U16, U32, U64},
};

pub const MAX_OUTSTANDING_LEASES: usize = 256;
pub const MAX_OUTSTANDING_LEASE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_ARENA_REGIONS: usize = 32;
pub const MAX_REGION_SLOTS: usize = 64;
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
const ARENA_MAGIC: u64 = 0x5941_4441_5245_4E33;
const ARENA_LAYOUT_VERSION: u64 = 1;
const ARENA_HEADER_BYTES: usize = 4096;
const ARENA_SLOT_BYTES: usize = 32;
const ARENA_REGION_CLASSES: [usize; 4] = [
    1024 * 1024,
    4 * 1024 * 1024,
    16 * 1024 * 1024,
    64 * 1024 * 1024,
];
const SLOT_FREE: u64 = 0;
const SLOT_READY: u64 = 1;
const SLOT_QUARANTINED: u64 = 2;
const MIDI_BATCH_LAYOUT_VERSION: u16 = 1;
const MIDI_NOTE_BATCH_MAGIC: [u8; 8] = *b"YADMN001";
const MIDI_EVENT_BATCH_MAGIC: [u8; 8] = *b"YADME001";

#[cfg(target_endian = "big")]
compile_error!("YADAW shared-page ABI currently supports little-endian targets only");

const _: () = assert!(HEADER_BYTES.is_multiple_of(align_of::<AtomicU64>()));
const _: () = assert!(METER_SLOT_BYTES.is_multiple_of(align_of::<AtomicU64>()));
const _: () = assert!(PARAMETER_SLOT_BYTES.is_multiple_of(align_of::<AtomicU64>()));
const _: () = assert!(size_of::<MidiBatchHeader>() == 32);
const _: () = assert!(size_of::<MidiNoteWire>() == 24);
const _: () = assert!(size_of::<MidiEventWire>() == 40);

#[derive(Clone, Copy, FromBytes, Immutable, IntoBytes, KnownLayout, Unaligned)]
#[repr(C)]
struct MidiBatchHeader {
    magic: [u8; 8],
    layout_version: U16,
    header_bytes: U16,
    element_bytes: U16,
    flags: U16,
    element_count: U32,
    data_offset: U32,
    total_bytes: U64,
}

/// Stable, little-endian representation of one MIDI note in a shared batch.
#[derive(Clone, Copy, FromBytes, Immutable, IntoBytes, KnownLayout, Unaligned)]
#[repr(C)]
pub struct MidiNoteWire {
    start_tick: U64,
    duration_ticks: U64,
    channel: u8,
    key: u8,
    velocity: u8,
    release_velocity: u8,
    reserved: [u8; 4],
}

impl MidiNoteWire {
    #[must_use]
    pub fn start_tick(self) -> u64 {
        self.start_tick.get()
    }

    #[must_use]
    pub fn duration_ticks(self) -> u64 {
        self.duration_ticks.get()
    }

    #[must_use]
    pub fn channel(self) -> u8 {
        self.channel
    }

    #[must_use]
    pub fn key(self) -> u8 {
        self.key
    }

    #[must_use]
    pub fn velocity(self) -> u8 {
        self.velocity
    }

    #[must_use]
    pub fn release_velocity(self) -> u8 {
        self.release_velocity
    }
}

impl From<&LiveMidiNote> for MidiNoteWire {
    fn from(value: &LiveMidiNote) -> Self {
        Self {
            start_tick: U64::new(value.start_tick),
            duration_ticks: U64::new(value.duration_ticks),
            channel: value.channel,
            key: value.key,
            velocity: value.velocity,
            release_velocity: value.release_velocity,
            reserved: [0; 4],
        }
    }
}

impl From<MidiNoteWire> for LiveMidiNote {
    fn from(value: MidiNoteWire) -> Self {
        Self {
            start_tick: value.start_tick(),
            duration_ticks: value.duration_ticks(),
            channel: value.channel(),
            key: value.key(),
            velocity: value.velocity(),
            release_velocity: value.release_velocity(),
        }
    }
}

#[derive(Clone, Copy, FromBytes, Immutable, IntoBytes, KnownLayout, Unaligned)]
#[repr(C)]
struct MidiEventWire {
    tick: U64,
    kind_offset: U32,
    kind_length: U32,
    data_offset: U64,
    data_length: U64,
    channel: u8,
    has_channel: u8,
    reserved: [u8; 6],
}

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
    #[error("shared blob belongs to a stale session or region generation")]
    StaleRegion,
    #[error("shared blob allocation is stale or not ready")]
    StaleAllocation,
    #[error("shared blob range is invalid")]
    InvalidRange,
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
    pub region_offers: Vec<RegionOffer>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RegionOffer {
    pub session_epoch: u64,
    pub region_id: u32,
    pub region_generation: u64,
    pub capacity: u64,
    pub memory: IpcSharedMemory,
}

/// Channels and persistent pages transferred during the one-shot rendezvous.
#[derive(Serialize, Deserialize)]
pub struct HostBootstrap {
    pub native_build_fingerprint: String,
    pub requests: IpcReceiver<WirePacket>,
    pub responses: IpcSender<WirePacket>,
    pub priority_requests: IpcReceiver<WirePacket>,
    pub priority_responses: IpcSender<WirePacket>,
    pub events: IpcSender<WirePacket>,
    pub telemetry_page: IpcSharedMemory,
    pub parameter_ring: IpcSharedMemory,
    pub session_epoch: u64,
}

#[derive(Debug, Clone, Copy)]
struct LeaseEntry {
    region_index: usize,
    slot: usize,
    allocation_generation: u64,
    offset: usize,
    bytes: usize,
    created_at: Instant,
}

pub struct LeaseRegistry {
    session_epoch: u64,
    next_id: u64,
    next_region_id: u32,
    entries: HashMap<u64, LeaseEntry>,
    bytes: usize,
    regions: Vec<ArenaRegion>,
    offers: u64,
    busy: u64,
    quarantined: u64,
    copied_bytes: u64,
}

impl LeaseRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::with_session_epoch(1)
    }

    #[must_use]
    pub fn with_session_epoch(session_epoch: u64) -> Self {
        Self {
            session_epoch: session_epoch.max(1),
            next_id: 1,
            next_region_id: 1,
            entries: HashMap::new(),
            bytes: 0,
            regions: Vec::new(),
            offers: 0,
            busy: 0,
            quarantined: 0,
            copied_bytes: 0,
        }
    }

    fn next_lease_id(&mut self) -> u64 {
        let id = self.next_id.max(1);
        self.next_id = id.wrapping_add(1).max(1);
        id
    }

    fn allocate(
        &mut self,
        bytes: &[u8],
    ) -> Result<(SharedBlobRef, Option<RegionOffer>), TransportError> {
        self.reap_expired();
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(TransportError::MessageTooLarge);
        }
        if self.entries.len() >= MAX_OUTSTANDING_LEASES
            || self.bytes.saturating_add(bytes.len()) > MAX_OUTSTANDING_LEASE_BYTES
        {
            self.busy = self.busy.saturating_add(1);
            return Err(TransportError::LeaseCapacity);
        }
        let aligned_length = align_up(bytes.len(), 8).ok_or(TransportError::MessageTooLarge)?;
        let mut allocation = None;
        for (index, region) in self.regions.iter_mut().enumerate() {
            if region.quarantined || region.capacity < aligned_length {
                continue;
            }
            if let Some(value) = region.reserve(aligned_length) {
                allocation = Some((index, value));
                break;
            }
        }
        if allocation.is_none() {
            let capacity = ARENA_REGION_CLASSES
                .into_iter()
                .find(|capacity| *capacity >= aligned_length)
                .ok_or(TransportError::MessageTooLarge)?;
            if self.regions.len() >= MAX_ARENA_REGIONS
                || self
                    .regions
                    .iter()
                    .map(|region| region.capacity)
                    .sum::<usize>()
                    .saturating_add(capacity)
                    > MAX_OUTSTANDING_LEASE_BYTES
            {
                self.busy = self.busy.saturating_add(1);
                return Err(TransportError::LeaseCapacity);
            }
            let region_id = self.next_region_id.max(1);
            self.next_region_id = region_id.wrapping_add(1).max(1);
            self.regions.push(ArenaRegion::new(
                self.session_epoch,
                region_id,
                1,
                capacity,
            )?);
            let index = self.regions.len() - 1;
            let value = self.regions[index]
                .reserve(aligned_length)
                .ok_or(TransportError::LeaseCapacity)?;
            allocation = Some((index, value));
        }
        let (region_index, allocation) = allocation.expect("allocation is established");
        let lease_id = self.next_lease_id();
        let region = &mut self.regions[region_index];
        region.write(allocation.offset, bytes)?;
        region.publish(
            allocation.slot,
            allocation.generation,
            allocation.offset,
            bytes.len(),
        );
        let offer = if region.offered {
            None
        } else {
            region.offered = true;
            self.offers = self.offers.saturating_add(1);
            Some(region.offer(self.session_epoch))
        };
        self.bytes += bytes.len();
        self.entries.insert(
            lease_id,
            LeaseEntry {
                region_index,
                slot: allocation.slot,
                allocation_generation: allocation.generation,
                offset: allocation.offset,
                bytes: bytes.len(),
                created_at: Instant::now(),
            },
        );
        self.copied_bytes = self
            .copied_bytes
            .saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
        Ok((
            SharedBlobRef {
                session_epoch: self.session_epoch,
                region_id: region.id,
                region_generation: region.generation,
                slot: u16::try_from(allocation.slot).map_err(|_| TransportError::InvalidRange)?,
                allocation_generation: allocation.generation,
                offset: u64::try_from(allocation.offset)
                    .map_err(|_| TransportError::InvalidRange)?,
                length: u64::try_from(bytes.len()).map_err(|_| TransportError::InvalidRange)?,
                lease_id,
            },
            offer,
        ))
    }

    pub fn release(&mut self, lease_ids: &[u64]) {
        for id in lease_ids {
            if let Some(entry) = self.entries.remove(id) {
                self.bytes = self.bytes.saturating_sub(entry.bytes);
                if let Some(region) = self.regions.get_mut(entry.region_index)
                    && !region.quarantined
                {
                    region.release(
                        entry.slot,
                        entry.allocation_generation,
                        entry.offset,
                        entry.bytes,
                    );
                }
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
        let region_indexes = expired
            .iter()
            .filter_map(|id| self.entries.get(id).map(|entry| entry.region_index))
            .collect::<HashSet<_>>();
        for region_index in region_indexes {
            if let Some(region) = self.regions.get_mut(region_index)
                && !region.quarantined
            {
                region.quarantine();
                self.quarantined = self.quarantined.saturating_add(1);
            }
        }
        for id in &expired {
            if let Some(entry) = self.entries.remove(id) {
                self.bytes = self.bytes.saturating_sub(entry.bytes);
            }
        }
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

    #[must_use]
    pub fn diagnostics(&self) -> ArenaDiagnostics {
        ArenaDiagnostics {
            region_count: u32::try_from(self.regions.len()).unwrap_or(u32::MAX),
            capacity_bytes: self
                .regions
                .iter()
                .map(|region| region.capacity as u64)
                .sum(),
            used_bytes: self.bytes as u64,
            high_water_bytes: self
                .regions
                .iter()
                .map(|region| region.high_water as u64)
                .sum(),
            offers: self.offers,
            busy: self.busy,
            quarantined_regions: self.quarantined,
            copied_bytes: self.copied_bytes,
        }
    }
}

impl Default for LeaseRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ArenaDiagnostics {
    pub region_count: u32,
    pub capacity_bytes: u64,
    pub used_bytes: u64,
    pub high_water_bytes: u64,
    pub offers: u64,
    pub busy: u64,
    pub quarantined_regions: u64,
    pub copied_bytes: u64,
}

struct ArenaAllocation {
    slot: usize,
    generation: u64,
    offset: usize,
}

struct ArenaRegion {
    id: u32,
    generation: u64,
    capacity: usize,
    memory: IpcSharedMemory,
    free: BTreeMap<usize, usize>,
    slot_generations: [u64; MAX_REGION_SLOTS],
    offered: bool,
    quarantined: bool,
    used: usize,
    high_water: usize,
}

impl ArenaRegion {
    fn new(
        session_epoch: u64,
        id: u32,
        generation: u64,
        capacity: usize,
    ) -> Result<Self, TransportError> {
        let total = ARENA_HEADER_BYTES
            .checked_add(capacity)
            .ok_or(TransportError::MessageTooLarge)?;
        let memory = IpcSharedMemory::from_byte(0, total);
        let page = AtomicPage::new(&memory);
        page.store_u64(0, ARENA_MAGIC, Ordering::Relaxed);
        page.store_u64(8, ARENA_LAYOUT_VERSION, Ordering::Relaxed);
        page.store_u64(16, session_epoch, Ordering::Relaxed);
        page.store_u64(24, u64::from(id), Ordering::Relaxed);
        page.store_u64(32, generation, Ordering::Relaxed);
        page.store_u64(
            40,
            u64::try_from(capacity).map_err(|_| TransportError::MessageTooLarge)?,
            Ordering::Release,
        );
        Ok(Self {
            id,
            generation,
            capacity,
            memory,
            free: BTreeMap::from([(0, capacity)]),
            slot_generations: [0; MAX_REGION_SLOTS],
            offered: false,
            quarantined: false,
            used: 0,
            high_water: 0,
        })
    }

    fn reserve(&mut self, length: usize) -> Option<ArenaAllocation> {
        let slot = (0..MAX_REGION_SLOTS).find(|slot| self.slot_state(*slot) == SLOT_FREE)?;
        let (&offset, &extent_length) = self.free.iter().find(|(_, extent)| **extent >= length)?;
        self.free.remove(&offset);
        if extent_length > length {
            self.free.insert(offset + length, extent_length - length);
        }
        let generation = self.slot_generations[slot].wrapping_add(1).max(1);
        self.slot_generations[slot] = generation;
        self.used = self.used.saturating_add(length);
        self.high_water = self.high_water.max(self.used);
        Some(ArenaAllocation {
            slot,
            generation,
            offset,
        })
    }

    fn write(&mut self, offset: usize, bytes: &[u8]) -> Result<(), TransportError> {
        let start = ARENA_HEADER_BYTES
            .checked_add(offset)
            .ok_or(TransportError::InvalidRange)?;
        let end = start
            .checked_add(bytes.len())
            .ok_or(TransportError::InvalidRange)?;
        if end > self.memory.len() {
            return Err(TransportError::InvalidRange);
        }
        // SAFETY: The producer owns allocation extents until their lease is
        // released. It writes only a currently non-published extent; readers
        // observe it after the slot's Release publication.
        unsafe {
            self.memory.deref_mut()[start..end].copy_from_slice(bytes);
        }
        Ok(())
    }

    fn publish(&self, slot: usize, generation: u64, offset: usize, length: usize) {
        let page = AtomicPage::new(&self.memory);
        let base = arena_slot_offset(slot);
        page.store_u64(base + 8, generation, Ordering::Relaxed);
        page.store_u64(base + 16, offset as u64, Ordering::Relaxed);
        page.store_u64(base + 24, length as u64, Ordering::Relaxed);
        page.store_u64(base, SLOT_READY, Ordering::Release);
    }

    fn release(&mut self, slot: usize, generation: u64, offset: usize, length: usize) {
        let page = AtomicPage::new(&self.memory);
        let base = arena_slot_offset(slot);
        if page.load_u64(base + 8, Ordering::Acquire) != generation {
            return;
        }
        page.store_u64(base, SLOT_FREE, Ordering::Release);
        let aligned = align_up(length, 8).unwrap_or(length);
        self.used = self.used.saturating_sub(aligned);
        self.insert_free_extent(offset, aligned);
    }

    fn quarantine(&mut self) {
        self.quarantined = true;
        let page = AtomicPage::new(&self.memory);
        for slot in 0..MAX_REGION_SLOTS {
            if page.load_u64(arena_slot_offset(slot), Ordering::Acquire) != SLOT_FREE {
                page.store_u64(arena_slot_offset(slot), SLOT_QUARANTINED, Ordering::Release);
            }
        }
    }

    fn insert_free_extent(&mut self, mut offset: usize, mut length: usize) {
        if let Some((&previous_offset, &previous_length)) = self.free.range(..offset).next_back()
            && previous_offset.saturating_add(previous_length) == offset
        {
            self.free.remove(&previous_offset);
            offset = previous_offset;
            length = length.saturating_add(previous_length);
        }
        if let Some((&next_offset, &next_length)) = self.free.range(offset..).next()
            && offset.saturating_add(length) == next_offset
        {
            self.free.remove(&next_offset);
            length = length.saturating_add(next_length);
        }
        self.free.insert(offset, length);
    }

    fn slot_state(&self, slot: usize) -> u64 {
        AtomicPage::new(&self.memory).load_u64(arena_slot_offset(slot), Ordering::Acquire)
    }

    fn offer(&self, session_epoch: u64) -> RegionOffer {
        RegionOffer {
            session_epoch,
            region_id: self.id,
            region_generation: self.generation,
            capacity: self.capacity as u64,
            memory: self.memory.clone(),
        }
    }
}

#[derive(Clone, Default)]
pub struct ArenaReceiver {
    session_epoch: u64,
    regions: HashMap<u32, ReceivedRegion>,
}

#[derive(Clone)]
struct ReceivedRegion {
    generation: u64,
    capacity: usize,
    memory: Arc<IpcSharedMemory>,
}

pub struct ResolvedBlob {
    memory: Arc<IpcSharedMemory>,
    start: usize,
    end: usize,
}

impl ResolvedBlob {
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        &self.memory[self.start..self.end]
    }
}

impl ArenaReceiver {
    #[must_use]
    pub fn new(session_epoch: u64) -> Self {
        Self {
            session_epoch,
            regions: HashMap::new(),
        }
    }

    pub fn register_offers(&mut self, offers: Vec<RegionOffer>) -> Result<(), TransportError> {
        for offer in offers {
            if offer.session_epoch != self.session_epoch {
                return Err(TransportError::StaleRegion);
            }
            let capacity =
                usize::try_from(offer.capacity).map_err(|_| TransportError::InvalidRange)?;
            validate_arena_region(&offer, capacity)?;
            if let Some(existing) = self.regions.get(&offer.region_id)
                && existing.generation != offer.region_generation
            {
                return Err(TransportError::StaleRegion);
            }
            self.regions
                .entry(offer.region_id)
                .or_insert(ReceivedRegion {
                    generation: offer.region_generation,
                    capacity,
                    memory: Arc::new(offer.memory),
                });
        }
        Ok(())
    }

    pub fn copy_blob(&self, reference: SharedBlobRef) -> Result<Vec<u8>, TransportError> {
        Ok(self.resolve(reference)?.to_vec())
    }

    pub fn acquire(&self, reference: SharedBlobRef) -> Result<ResolvedBlob, TransportError> {
        self.resolve(reference)?;
        let region = self
            .regions
            .get(&reference.region_id)
            .ok_or(TransportError::UnknownRegion)?;
        let offset = usize::try_from(reference.offset).map_err(|_| TransportError::InvalidRange)?;
        let length = usize::try_from(reference.length).map_err(|_| TransportError::InvalidRange)?;
        let start = ARENA_HEADER_BYTES
            .checked_add(offset)
            .ok_or(TransportError::InvalidRange)?;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= region.memory.len())
            .ok_or(TransportError::InvalidRange)?;
        Ok(ResolvedBlob {
            memory: Arc::clone(&region.memory),
            start,
            end,
        })
    }

    pub fn resolve(&self, reference: SharedBlobRef) -> Result<&[u8], TransportError> {
        if reference.session_epoch != self.session_epoch {
            return Err(TransportError::StaleRegion);
        }
        let region = self
            .regions
            .get(&reference.region_id)
            .ok_or(TransportError::UnknownRegion)?;
        if region.generation != reference.region_generation {
            return Err(TransportError::StaleRegion);
        }
        let slot = usize::from(reference.slot);
        if slot >= MAX_REGION_SLOTS {
            return Err(TransportError::InvalidRange);
        }
        let page = AtomicPage::new(&region.memory);
        let base = arena_slot_offset(slot);
        if page.load_u64(base, Ordering::Acquire) != SLOT_READY
            || page.load_u64(base + 8, Ordering::Relaxed) != reference.allocation_generation
        {
            return Err(TransportError::StaleAllocation);
        }
        let published_offset = page.load_u64(base + 16, Ordering::Relaxed);
        let published_length = page.load_u64(base + 24, Ordering::Relaxed);
        if published_offset != reference.offset || published_length != reference.length {
            return Err(TransportError::InvalidRange);
        }
        let offset = usize::try_from(reference.offset).map_err(|_| TransportError::InvalidRange)?;
        let length = usize::try_from(reference.length).map_err(|_| TransportError::InvalidRange)?;
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= region.capacity)
            .ok_or(TransportError::InvalidRange)?;
        let start = ARENA_HEADER_BYTES
            .checked_add(offset)
            .ok_or(TransportError::InvalidRange)?;
        Ok(&region.memory[start..ARENA_HEADER_BYTES + end])
    }
}

/// Borrowed MIDI notes backed either by the logical request or by a validated
/// fixed-layout shared-memory batch.
pub enum MidiNoteBatchView<'a> {
    Inline(&'a [LiveMidiNote]),
    Shared(&'a [MidiNoteWire]),
}

impl MidiNoteBatchView<'_> {
    #[must_use]
    pub fn len(&self) -> usize {
        match self {
            Self::Inline(notes) => notes.len(),
            Self::Shared(notes) => notes.len(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn parse_midi_batch_header(
    bytes: &[u8],
    expected_magic: [u8; 8],
    expected_element_bytes: usize,
) -> Result<(usize, usize), TransportError> {
    let (header, _) =
        MidiBatchHeader::ref_from_prefix(bytes).map_err(|_| TransportError::InvalidSharedLayout)?;
    let header_bytes = usize::from(header.header_bytes.get());
    let element_bytes = usize::from(header.element_bytes.get());
    let element_count =
        usize::try_from(header.element_count.get()).map_err(|_| TransportError::InvalidRange)?;
    let data_offset =
        usize::try_from(header.data_offset.get()).map_err(|_| TransportError::InvalidRange)?;
    let total_bytes =
        usize::try_from(header.total_bytes.get()).map_err(|_| TransportError::InvalidRange)?;
    let descriptor_end = header_bytes
        .checked_add(
            element_count
                .checked_mul(element_bytes)
                .ok_or(TransportError::InvalidRange)?,
        )
        .ok_or(TransportError::InvalidRange)?;
    if header.magic != expected_magic
        || header.layout_version.get() != MIDI_BATCH_LAYOUT_VERSION
        || header_bytes != size_of::<MidiBatchHeader>()
        || element_bytes != expected_element_bytes
        || header.flags.get() != 0
        || data_offset != descriptor_end
        || total_bytes != bytes.len()
        || data_offset > total_bytes
    {
        return Err(TransportError::InvalidSharedLayout);
    }
    Ok((element_count, data_offset))
}

fn parse_midi_notes(bytes: &[u8]) -> Result<&[MidiNoteWire], TransportError> {
    let (element_count, data_offset) =
        parse_midi_batch_header(bytes, MIDI_NOTE_BATCH_MAGIC, size_of::<MidiNoteWire>())?;
    if data_offset != bytes.len() {
        return Err(TransportError::InvalidSharedLayout);
    }
    let entries = bytes
        .get(size_of::<MidiBatchHeader>()..data_offset)
        .ok_or(TransportError::InvalidSharedLayout)?;
    let notes = <[MidiNoteWire]>::ref_from_bytes_with_elems(entries, element_count)
        .map_err(|_| TransportError::InvalidSharedLayout)?;
    if notes.iter().any(|note| note.reserved != [0; 4]) {
        return Err(TransportError::InvalidSharedLayout);
    }
    Ok(notes)
}

fn parse_midi_events(bytes: &[u8]) -> Result<(&[MidiEventWire], &[u8]), TransportError> {
    let (element_count, data_offset) =
        parse_midi_batch_header(bytes, MIDI_EVENT_BATCH_MAGIC, size_of::<MidiEventWire>())?;
    let entries = bytes
        .get(size_of::<MidiBatchHeader>()..data_offset)
        .ok_or(TransportError::InvalidSharedLayout)?;
    let events = <[MidiEventWire]>::ref_from_bytes_with_elems(entries, element_count)
        .map_err(|_| TransportError::InvalidSharedLayout)?;
    let data = bytes
        .get(data_offset..)
        .ok_or(TransportError::InvalidSharedLayout)?;
    for event in events {
        if event.has_channel > 1 || event.reserved != [0; 6] {
            return Err(TransportError::InvalidSharedLayout);
        }
        let kind_offset =
            usize::try_from(event.kind_offset.get()).map_err(|_| TransportError::InvalidRange)?;
        let kind_length =
            usize::try_from(event.kind_length.get()).map_err(|_| TransportError::InvalidRange)?;
        let payload_offset =
            usize::try_from(event.data_offset.get()).map_err(|_| TransportError::InvalidRange)?;
        let payload_length =
            usize::try_from(event.data_length.get()).map_err(|_| TransportError::InvalidRange)?;
        let kind_end = kind_offset
            .checked_add(kind_length)
            .ok_or(TransportError::InvalidRange)?;
        let payload_end = payload_offset
            .checked_add(payload_length)
            .ok_or(TransportError::InvalidRange)?;
        let kind = data
            .get(kind_offset..kind_end)
            .ok_or(TransportError::InvalidRange)?;
        data.get(payload_offset..payload_end)
            .ok_or(TransportError::InvalidRange)?;
        std::str::from_utf8(kind).map_err(|_| TransportError::InvalidSharedLayout)?;
    }
    Ok((events, data))
}

/// Resolves a MIDI note batch without materializing a temporary `Vec`.
///
/// Shared notes borrow the arena mapping and remain valid only for the
/// returned view's lifetime.
pub fn resolve_midi_note_batch<'a>(
    batch: &'a MidiNoteBatch,
    arena: &'a ArenaReceiver,
) -> Result<MidiNoteBatchView<'a>, TransportError> {
    match batch {
        MidiNoteBatch::Inline { notes } => Ok(MidiNoteBatchView::Inline(notes)),
        MidiNoteBatch::Shared { reference } => Ok(MidiNoteBatchView::Shared(parse_midi_notes(
            arena.resolve(*reference)?,
        )?)),
    }
}

fn arena_slot_offset(slot: usize) -> usize {
    64 + slot * ARENA_SLOT_BYTES
}

fn align_up(value: usize, alignment: usize) -> Option<usize> {
    value
        .checked_add(alignment - 1)
        .map(|value| value & !(alignment - 1))
}

fn validate_arena_region(offer: &RegionOffer, capacity: usize) -> Result<(), TransportError> {
    let expected = ARENA_HEADER_BYTES
        .checked_add(capacity)
        .ok_or(TransportError::InvalidRange)?;
    if offer.memory.len() != expected {
        return Err(TransportError::InvalidRange);
    }
    let page = AtomicPage::new(&offer.memory);
    if page.load_u64(0, Ordering::Acquire) != ARENA_MAGIC
        || page.load_u64(8, Ordering::Acquire) != ARENA_LAYOUT_VERSION
        || page.load_u64(16, Ordering::Acquire) != offer.session_epoch
        || page.load_u64(24, Ordering::Acquire) != u64::from(offer.region_id)
        || page.load_u64(32, Ordering::Acquire) != offer.region_generation
        || page.load_u64(40, Ordering::Acquire) != offer.capacity
    {
        return Err(TransportError::InvalidSharedLayout);
    }
    Ok(())
}

struct AttachmentBuilder<'a> {
    arena: &'a mut LeaseRegistry,
    offers: Vec<RegionOffer>,
    lease_ids: Vec<u64>,
    total_bytes: usize,
    committed: bool,
}

impl<'a> AttachmentBuilder<'a> {
    fn new(arena: &'a mut LeaseRegistry) -> Self {
        Self {
            arena,
            offers: Vec::new(),
            lease_ids: Vec::new(),
            total_bytes: 0,
            committed: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<SharedBlobRef, TransportError> {
        self.total_bytes = checked_packet_attachment_bytes(self.total_bytes, bytes.len())?;
        let (reference, offer) = self.arena.allocate(bytes)?;
        self.lease_ids.push(reference.lease_id);
        if let Some(offer) = offer {
            self.offers.push(offer);
        }
        Ok(reference)
    }

    fn finish(mut self) -> Vec<RegionOffer> {
        self.committed = true;
        std::mem::take(&mut self.offers)
    }
}

impl Drop for AttachmentBuilder<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.arena.release(&self.lease_ids);
        }
    }
}

fn checked_packet_attachment_bytes(
    current: usize,
    additional: usize,
) -> Result<usize, TransportError> {
    current
        .checked_add(additional)
        .filter(|total| *total <= MAX_MESSAGE_BYTES)
        .ok_or(TransportError::MessageTooLarge)
}

fn externalize_binary(
    payload: &mut BinaryPayload,
    builder: &mut AttachmentBuilder,
    attachments: &[&[u8]],
) -> Result<(), TransportError> {
    let bytes = match payload {
        BinaryPayload::Inline { bytes } if bytes.len() > INLINE_BLOB_LIMIT => bytes.as_slice(),
        BinaryPayload::Inline { .. } | BinaryPayload::Shared { .. } => return Ok(()),
        BinaryPayload::Attachment {
            index,
            offset,
            length,
        } => {
            let attachment = attachments
                .get(usize::from(*index))
                .ok_or(TransportError::InvalidRange)?;
            let offset = usize::try_from(*offset).map_err(|_| TransportError::InvalidRange)?;
            let length = usize::try_from(*length).map_err(|_| TransportError::InvalidRange)?;
            let end = offset
                .checked_add(length)
                .ok_or(TransportError::InvalidRange)?;
            attachment
                .get(offset..end)
                .ok_or(TransportError::InvalidRange)?
        }
    };
    let reference = builder.push(bytes)?;
    *payload = BinaryPayload::Shared { reference };
    Ok(())
}

fn externalize_binary_from_arena(
    payload: &mut BinaryPayload,
    builder: &mut AttachmentBuilder,
    source: &ArenaReceiver,
) -> Result<(), TransportError> {
    if let BinaryPayload::Shared { reference } = payload {
        let next = builder.push(source.resolve(*reference)?)?;
        *payload = BinaryPayload::Shared { reference: next };
        return Ok(());
    }
    externalize_binary(payload, builder, &[])
}

fn midi_batch_header(
    magic: [u8; 8],
    element_bytes: usize,
    element_count: usize,
    data_offset: usize,
    total_bytes: usize,
) -> Result<MidiBatchHeader, TransportError> {
    Ok(MidiBatchHeader {
        magic,
        layout_version: U16::new(MIDI_BATCH_LAYOUT_VERSION),
        header_bytes: U16::new(
            u16::try_from(size_of::<MidiBatchHeader>())
                .map_err(|_| TransportError::InvalidRange)?,
        ),
        element_bytes: U16::new(
            u16::try_from(element_bytes).map_err(|_| TransportError::InvalidRange)?,
        ),
        flags: U16::new(0),
        element_count: U32::new(
            u32::try_from(element_count).map_err(|_| TransportError::InvalidRange)?,
        ),
        data_offset: U32::new(
            u32::try_from(data_offset).map_err(|_| TransportError::InvalidRange)?,
        ),
        total_bytes: U64::new(
            u64::try_from(total_bytes).map_err(|_| TransportError::InvalidRange)?,
        ),
    })
}

fn encoded_midi_notes(notes: &[LiveMidiNote]) -> Result<Vec<u8>, TransportError> {
    let entries_bytes = notes
        .len()
        .checked_mul(size_of::<MidiNoteWire>())
        .ok_or(TransportError::MessageTooLarge)?;
    let total_bytes = size_of::<MidiBatchHeader>()
        .checked_add(entries_bytes)
        .filter(|bytes| *bytes <= MAX_MESSAGE_BYTES)
        .ok_or(TransportError::MessageTooLarge)?;
    let header = midi_batch_header(
        MIDI_NOTE_BATCH_MAGIC,
        size_of::<MidiNoteWire>(),
        notes.len(),
        total_bytes,
        total_bytes,
    )?;
    let mut encoded = Vec::with_capacity(total_bytes);
    encoded.extend_from_slice(header.as_bytes());
    for note in notes {
        encoded.extend_from_slice(MidiNoteWire::from(note).as_bytes());
    }
    debug_assert_eq!(encoded.len(), total_bytes);
    Ok(encoded)
}

fn outgoing_binary<'a>(
    payload: &'a BinaryPayload,
    attachments: &'a [&'a [u8]],
) -> Result<&'a [u8], TransportError> {
    match payload {
        BinaryPayload::Inline { bytes } => Ok(bytes),
        BinaryPayload::Attachment {
            index,
            offset,
            length,
        } => {
            let attachment = attachments
                .get(usize::from(*index))
                .ok_or(TransportError::InvalidRange)?;
            let offset = usize::try_from(*offset).map_err(|_| TransportError::InvalidRange)?;
            let length = usize::try_from(*length).map_err(|_| TransportError::InvalidRange)?;
            let end = offset
                .checked_add(length)
                .ok_or(TransportError::InvalidRange)?;
            attachment
                .get(offset..end)
                .ok_or(TransportError::InvalidRange)
        }
        BinaryPayload::Shared { .. } => Err(TransportError::InvalidSharedLayout),
    }
}

fn encoded_midi_events(
    events: &[LiveMidiEvent],
    attachments: &[&[u8]],
) -> Result<Vec<u8>, TransportError> {
    let descriptors_bytes = events
        .len()
        .checked_mul(size_of::<MidiEventWire>())
        .ok_or(TransportError::MessageTooLarge)?;
    let data_offset = size_of::<MidiBatchHeader>()
        .checked_add(descriptors_bytes)
        .ok_or(TransportError::MessageTooLarge)?;
    let mut data_bytes = 0_usize;
    for event in events {
        let payload_bytes = outgoing_binary(&event.data, attachments)?.len();
        data_bytes = data_bytes
            .checked_add(event.kind.len())
            .and_then(|bytes| bytes.checked_add(payload_bytes))
            .ok_or(TransportError::MessageTooLarge)?;
    }
    let total_bytes = data_offset
        .checked_add(data_bytes)
        .filter(|bytes| *bytes <= MAX_MESSAGE_BYTES)
        .ok_or(TransportError::MessageTooLarge)?;
    let header = midi_batch_header(
        MIDI_EVENT_BATCH_MAGIC,
        size_of::<MidiEventWire>(),
        events.len(),
        data_offset,
        total_bytes,
    )?;
    let mut encoded = Vec::with_capacity(total_bytes);
    encoded.extend_from_slice(header.as_bytes());
    let mut tail_offset = 0_usize;
    for event in events {
        let data = outgoing_binary(&event.data, attachments)?;
        let kind_offset = u32::try_from(tail_offset).map_err(|_| TransportError::InvalidRange)?;
        let kind_length =
            u32::try_from(event.kind.len()).map_err(|_| TransportError::InvalidRange)?;
        tail_offset = tail_offset
            .checked_add(event.kind.len())
            .ok_or(TransportError::MessageTooLarge)?;
        let payload_offset =
            u64::try_from(tail_offset).map_err(|_| TransportError::InvalidRange)?;
        let payload_length = u64::try_from(data.len()).map_err(|_| TransportError::InvalidRange)?;
        tail_offset = tail_offset
            .checked_add(data.len())
            .ok_or(TransportError::MessageTooLarge)?;
        let descriptor = MidiEventWire {
            tick: U64::new(event.tick),
            kind_offset: U32::new(kind_offset),
            kind_length: U32::new(kind_length),
            data_offset: U64::new(payload_offset),
            data_length: U64::new(payload_length),
            channel: event.channel.unwrap_or_default(),
            has_channel: u8::from(event.channel.is_some()),
            reserved: [0; 6],
        };
        encoded.extend_from_slice(descriptor.as_bytes());
    }
    for event in events {
        encoded.extend_from_slice(event.kind.as_bytes());
        encoded.extend_from_slice(outgoing_binary(&event.data, attachments)?);
    }
    debug_assert_eq!(encoded.len(), total_bytes);
    Ok(encoded)
}

fn externalize_midi(
    batch: &mut MidiNoteBatch,
    builder: &mut AttachmentBuilder,
) -> Result<(), TransportError> {
    let MidiNoteBatch::Inline { notes } = batch else {
        return Ok(());
    };
    let encoded = encoded_midi_notes(notes)?;
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
    attachments: &[&[u8]],
) -> Result<(), TransportError> {
    let MidiEventBatch::Inline { events } = batch else {
        return Ok(());
    };
    let encoded = encoded_midi_events(events, attachments)?;
    if encoded.len() > INLINE_BLOB_LIMIT {
        let reference = builder.push(&encoded)?;
        *batch = MidiEventBatch::Shared { reference };
        return Ok(());
    }
    for event in events {
        externalize_binary(&mut event.data, builder, attachments)?;
    }
    Ok(())
}

fn visit_graph_update(
    update: &mut GraphUpdate,
    builder: &mut AttachmentBuilder,
    attachments: &[&[u8]],
) -> Result<(), TransportError> {
    match update {
        GraphUpdate::Replace { graph, .. } => {
            for clip in &mut graph.midi_clips {
                externalize_midi(&mut clip.notes, builder)?;
                externalize_midi_events(&mut clip.events, builder, attachments)?;
            }
        }
        GraphUpdate::Patch { ops, .. } => {
            for op in ops {
                if let GraphOp::UpsertMidiClip { value } = op {
                    externalize_midi(&mut value.notes, builder)?;
                    externalize_midi_events(&mut value.events, builder, attachments)?;
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
    let mut builder = AttachmentBuilder::new(leases);
    match &mut request.command {
        ControlCommand::BenchmarkEcho { payload } => {
            externalize_binary(payload, &mut builder, &[])?;
        }
        ControlCommand::LoadPlugin {
            component_state,
            controller_state,
            ..
        } => {
            externalize_binary(component_state, &mut builder, &[])?;
            externalize_binary(controller_state, &mut builder, &[])?;
        }
        ControlCommand::UpdateGraph { update } => visit_graph_update(update, &mut builder, &[])?,
        _ => {}
    }
    let body = encode_body(&request)?;
    let region_offers = builder.finish();
    Ok(WirePacket {
        body,
        region_offers,
    })
}

pub fn encode_request_with_attachments(
    mut request: ControlRequest,
    attachments: &[&[u8]],
    leases: &mut LeaseRegistry,
) -> Result<WirePacket, TransportError> {
    let mut builder = AttachmentBuilder::new(leases);
    match &mut request.command {
        ControlCommand::BenchmarkEcho { payload } => {
            externalize_binary(payload, &mut builder, attachments)?;
        }
        ControlCommand::LoadPlugin {
            component_state,
            controller_state,
            ..
        } => {
            externalize_binary(component_state, &mut builder, attachments)?;
            externalize_binary(controller_state, &mut builder, attachments)?;
        }
        ControlCommand::UpdateGraph { update } => {
            visit_graph_update(update, &mut builder, attachments)?;
        }
        _ => {}
    }
    let body = encode_body(&request)?;
    Ok(WirePacket {
        body,
        region_offers: builder.finish(),
    })
}

pub fn encode_response(
    mut response: ControlResponse,
    leases: &mut LeaseRegistry,
) -> Result<WirePacket, TransportError> {
    let mut builder = AttachmentBuilder::new(leases);
    match &mut response.result {
        ControlResult::BenchmarkEcho { payload } => {
            externalize_binary(payload, &mut builder, &[])?;
        }
        ControlResult::RecordingWaveform { waveform } => {
            externalize_binary(&mut waveform.peaks, &mut builder, &[])?;
        }
        ControlResult::PluginState {
            component_state,
            controller_state,
        } => {
            externalize_binary(component_state, &mut builder, &[])?;
            externalize_binary(controller_state, &mut builder, &[])?;
        }
        _ => {}
    }
    let body = encode_body(&response)?;
    let region_offers = builder.finish();
    Ok(WirePacket {
        body,
        region_offers,
    })
}

pub fn encode_response_from_arena(
    mut response: ControlResponse,
    leases: &mut LeaseRegistry,
    source: &ArenaReceiver,
) -> Result<WirePacket, TransportError> {
    let mut builder = AttachmentBuilder::new(leases);
    match &mut response.result {
        ControlResult::BenchmarkEcho { payload } => {
            externalize_binary_from_arena(payload, &mut builder, source)?;
        }
        ControlResult::RecordingWaveform { waveform } => {
            externalize_binary_from_arena(&mut waveform.peaks, &mut builder, source)?;
        }
        ControlResult::PluginState {
            component_state,
            controller_state,
        } => {
            externalize_binary_from_arena(component_state, &mut builder, source)?;
            externalize_binary_from_arena(controller_state, &mut builder, source)?;
        }
        _ => {}
    }
    let body = encode_body(&response)?;
    Ok(WirePacket {
        body,
        region_offers: builder.finish(),
    })
}

pub fn encode_priority<T: Serialize>(value: &T) -> Result<WirePacket, TransportError> {
    Ok(WirePacket {
        body: encode_body(value)?,
        region_offers: Vec::new(),
    })
}

pub fn encode_event(
    event: &HostEvent,
    region_offers: Vec<RegionOffer>,
) -> Result<WirePacket, TransportError> {
    Ok(WirePacket {
        body: encode_body(event)?,
        region_offers,
    })
}

pub fn decode_request(
    packet: WirePacket,
    arena: &mut ArenaReceiver,
) -> Result<(ControlRequest, Vec<u64>), TransportError> {
    let (mut request, leases) = decode_request_deferred(packet, arena)?;
    materialize_request_payloads(&mut request.command, arena)?;
    Ok((request, leases))
}

pub fn decode_request_deferred(
    packet: WirePacket,
    arena: &mut ArenaReceiver,
) -> Result<(ControlRequest, Vec<u64>), TransportError> {
    arena.register_offers(packet.region_offers)?;
    let request: ControlRequest = decode_body(&packet.body)?;
    let mut leases = HashSet::new();
    validate_request_payloads(&request.command, arena, &mut leases)?;
    Ok((request, leases.into_iter().collect()))
}

pub fn materialize_request_payloads(
    command: &mut ControlCommand,
    arena: &ArenaReceiver,
) -> Result<(), TransportError> {
    let mut leases = HashSet::new();
    match command {
        ControlCommand::BenchmarkEcho { payload } => {
            materialize_binary(payload, arena, &mut leases)?;
        }
        ControlCommand::LoadPlugin {
            component_state,
            controller_state,
            ..
        } => {
            materialize_binary(component_state, arena, &mut leases)?;
            materialize_binary(controller_state, arena, &mut leases)?;
        }
        ControlCommand::UpdateGraph { update } => {
            materialize_graph_update(update, arena)?;
        }
        _ => {}
    }
    Ok(())
}

pub fn decode_response(
    packet: WirePacket,
    arena: &mut ArenaReceiver,
) -> Result<(ControlResponse, Vec<u64>), TransportError> {
    arena.register_offers(packet.region_offers)?;
    let mut response: ControlResponse = decode_body(&packet.body)?;
    let mut leases = HashSet::new();
    match &mut response.result {
        ControlResult::BenchmarkEcho { payload } => {
            materialize_binary(payload, arena, &mut leases)?;
        }
        ControlResult::RecordingWaveform { waveform } => {
            materialize_binary(&mut waveform.peaks, arena, &mut leases)?;
        }
        ControlResult::PluginState {
            component_state,
            controller_state,
        } => {
            materialize_binary(component_state, arena, &mut leases)?;
            materialize_binary(controller_state, arena, &mut leases)?;
        }
        _ => {}
    }
    Ok((response, leases.into_iter().collect()))
}

pub type AttachmentResponse = (ControlResponse, Vec<Vec<u8>>, Vec<u64>);

pub fn decode_response_to_attachments(
    packet: WirePacket,
    arena: &mut ArenaReceiver,
) -> Result<AttachmentResponse, TransportError> {
    arena.register_offers(packet.region_offers)?;
    let mut response: ControlResponse = decode_body(&packet.body)?;
    let mut attachments = Vec::new();
    let mut leases = HashSet::new();
    match &mut response.result {
        ControlResult::BenchmarkEcho { payload } => {
            extract_binary_attachment(payload, arena, &mut attachments, &mut leases)?;
        }
        ControlResult::RecordingWaveform { waveform } => {
            extract_binary_attachment(&mut waveform.peaks, arena, &mut attachments, &mut leases)?;
        }
        ControlResult::PluginState {
            component_state,
            controller_state,
        } => {
            extract_binary_attachment(component_state, arena, &mut attachments, &mut leases)?;
            extract_binary_attachment(controller_state, arena, &mut attachments, &mut leases)?;
        }
        _ => {}
    }
    Ok((response, attachments, leases.into_iter().collect()))
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

fn validate_request_payloads(
    command: &ControlCommand,
    arena: &ArenaReceiver,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    match command {
        ControlCommand::BenchmarkEcho { payload } => {
            validate_binary(payload, arena, leases)?;
        }
        ControlCommand::LoadPlugin {
            component_state,
            controller_state,
            ..
        } => {
            validate_binary(component_state, arena, leases)?;
            validate_binary(controller_state, arena, leases)?;
        }
        ControlCommand::UpdateGraph { update } => {
            validate_graph_update(update, arena, leases)?;
        }
        _ => {}
    }
    Ok(())
}

fn validate_binary(
    payload: &BinaryPayload,
    arena: &ArenaReceiver,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    if let BinaryPayload::Shared { reference } = payload {
        arena.resolve(*reference)?;
        leases.insert(reference.lease_id);
    }
    Ok(())
}

fn validate_midi(
    batch: &MidiNoteBatch,
    arena: &ArenaReceiver,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    if let MidiNoteBatch::Shared { reference } = batch {
        parse_midi_notes(arena.resolve(*reference)?)?;
        leases.insert(reference.lease_id);
    }
    Ok(())
}

fn validate_midi_events(
    batch: &MidiEventBatch,
    arena: &ArenaReceiver,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    match batch {
        MidiEventBatch::Inline { events } => {
            for event in events {
                validate_binary(&event.data, arena, leases)?;
            }
        }
        MidiEventBatch::Shared { reference } => {
            parse_midi_events(arena.resolve(*reference)?)?;
            leases.insert(reference.lease_id);
        }
    }
    Ok(())
}

fn validate_graph_update(
    update: &GraphUpdate,
    arena: &ArenaReceiver,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    match update {
        GraphUpdate::Replace { graph, .. } => {
            for clip in &graph.midi_clips {
                validate_midi(&clip.notes, arena, leases)?;
                validate_midi_events(&clip.events, arena, leases)?;
            }
        }
        GraphUpdate::Patch { ops, .. } => {
            for operation in ops {
                if let GraphOp::UpsertMidiClip { value } = operation {
                    validate_midi(&value.notes, arena, leases)?;
                    validate_midi_events(&value.events, arena, leases)?;
                }
            }
        }
    }
    Ok(())
}

fn materialize_binary(
    payload: &mut BinaryPayload,
    arena: &ArenaReceiver,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    let BinaryPayload::Shared { reference } = payload else {
        return Ok(());
    };
    let bytes = arena.copy_blob(*reference)?;
    leases.insert(reference.lease_id);
    *payload = BinaryPayload::Inline { bytes };
    Ok(())
}

fn extract_binary_attachment(
    payload: &mut BinaryPayload,
    arena: &ArenaReceiver,
    attachments: &mut Vec<Vec<u8>>,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    let BinaryPayload::Shared { reference } = payload else {
        return Ok(());
    };
    let bytes = arena.copy_blob(*reference)?;
    let index = u16::try_from(attachments.len()).map_err(|_| TransportError::InvalidRange)?;
    let length = u64::try_from(bytes.len()).map_err(|_| TransportError::InvalidRange)?;
    leases.insert(reference.lease_id);
    attachments.push(bytes);
    *payload = BinaryPayload::Attachment {
        index,
        offset: 0,
        length,
    };
    Ok(())
}

fn materialize_midi(
    batch: &mut MidiNoteBatch,
    arena: &ArenaReceiver,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    let MidiNoteBatch::Shared { reference } = batch else {
        return Ok(());
    };
    let notes = parse_midi_notes(arena.resolve(*reference)?)?
        .iter()
        .copied()
        .map(LiveMidiNote::from)
        .collect();
    leases.insert(reference.lease_id);
    *batch = MidiNoteBatch::Inline { notes };
    Ok(())
}

fn materialize_midi_events(
    batch: &mut MidiEventBatch,
    arena: &ArenaReceiver,
    leases: &mut HashSet<u64>,
) -> Result<(), TransportError> {
    match batch {
        MidiEventBatch::Inline { events } => {
            for event in events {
                materialize_binary(&mut event.data, arena, leases)?;
            }
        }
        MidiEventBatch::Shared { reference } => {
            let (wire_events, data) = parse_midi_events(arena.resolve(*reference)?)?;
            let mut events = Vec::with_capacity(wire_events.len());
            for event in wire_events {
                let kind_offset = usize::try_from(event.kind_offset.get())
                    .map_err(|_| TransportError::InvalidRange)?;
                let kind_length = usize::try_from(event.kind_length.get())
                    .map_err(|_| TransportError::InvalidRange)?;
                let payload_offset = usize::try_from(event.data_offset.get())
                    .map_err(|_| TransportError::InvalidRange)?;
                let payload_length = usize::try_from(event.data_length.get())
                    .map_err(|_| TransportError::InvalidRange)?;
                let kind_end = kind_offset
                    .checked_add(kind_length)
                    .ok_or(TransportError::InvalidRange)?;
                let payload_end = payload_offset
                    .checked_add(payload_length)
                    .ok_or(TransportError::InvalidRange)?;
                let kind = std::str::from_utf8(
                    data.get(kind_offset..kind_end)
                        .ok_or(TransportError::InvalidRange)?,
                )
                .map_err(|_| TransportError::InvalidSharedLayout)?
                .to_owned();
                let bytes = data
                    .get(payload_offset..payload_end)
                    .ok_or(TransportError::InvalidRange)?
                    .to_vec();
                events.push(LiveMidiEvent {
                    tick: event.tick.get(),
                    channel: (event.has_channel != 0).then_some(event.channel),
                    kind,
                    data: BinaryPayload::inline(bytes),
                });
            }
            leases.insert(reference.lease_id);
            *batch = MidiEventBatch::Inline { events };
        }
    }
    Ok(())
}

/// Converts shared graph payloads into owned protocol values for snapshots
/// that must outlive the request lease.
pub fn materialize_graph_update(
    update: &mut GraphUpdate,
    arena: &ArenaReceiver,
) -> Result<(), TransportError> {
    match update {
        GraphUpdate::Replace { graph, .. } => {
            materialize_mixer_graph(graph, arena)?;
        }
        GraphUpdate::Patch { ops, .. } => {
            let mut leases = HashSet::new();
            for op in ops {
                if let GraphOp::UpsertMidiClip { value } = op {
                    materialize_midi(&mut value.notes, arena, &mut leases)?;
                    materialize_midi_events(&mut value.events, arena, &mut leases)?;
                }
            }
        }
    }
    Ok(())
}

/// Converts shared MIDI batches in a graph into owned values so the graph may
/// be retained after its request leases are released.
pub fn materialize_mixer_graph(
    graph: &mut LiveMixerGraph,
    arena: &ArenaReceiver,
) -> Result<(), TransportError> {
    let mut leases = HashSet::new();
    for clip in &mut graph.midi_clips {
        materialize_midi(&mut clip.notes, arena, &mut leases)?;
        materialize_midi_events(&mut clip.events, arena, &mut leases)?;
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
        ControlCommand, ControlRequest, GraphUpdate, LiveMidiClip, LiveMidiEvent, LiveMidiNote,
        LiveMixerGraph, LiveTempoEvent, LiveTimeSignatureEvent, MidiEventBatch, MidiNoteBatch,
        RecordingWaveform,
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
                audio_mode: yadaw_dsp_runtime::protocol::PluginAudioMode::Stereo,
                sample_rate: 48_000.0,
                component_state: BinaryPayload::inline(vec![7; size]),
                controller_state: BinaryPayload::inline(Vec::new()),
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
                audio_mode: yadaw_dsp_runtime::protocol::PluginAudioMode::Stereo,
                sample_rate: 48_000.0,
                component_state: BinaryPayload::inline(vec![1; INLINE_BLOB_LIMIT + 3]),
                controller_state: BinaryPayload::inline(vec![2; INLINE_BLOB_LIMIT + 5]),
            },
        };
        let mut leases = LeaseRegistry::new();
        let packet = encode_request(request, &mut leases).unwrap();
        assert_eq!(packet.region_offers.len(), 1);
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
        assert_eq!(component.region_id, controller.region_id);
        assert_eq!(component.offset % 8, 0);
        assert_eq!(controller.offset % 8, 0);
        assert_ne!(component.lease_id, controller.lease_id);
        let mut receiver = ArenaReceiver::new(1);
        let (decoded, release) = decode_request(packet, &mut receiver).unwrap();
        assert_eq!(release.len(), 2);
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
    fn warm_allocations_reuse_a_registered_region_without_another_offer() {
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
        sender.release(&leases);
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
        sender.entries.get_mut(&first.lease_id).unwrap().created_at =
            Instant::now() - LEASE_TIMEOUT;
        assert_eq!(sender.reap_expired(), vec![first.lease_id]);
        assert_eq!(sender.diagnostics().quarantined_regions, 1);

        let (second, offer) = sender.allocate(&vec![2; 96 * 1024]).unwrap();
        assert_ne!(first.region_id, second.region_id);
        assert!(offer.is_some());
    }

    #[test]
    fn out_of_order_release_coalesces_extents_for_a_larger_allocation() {
        let mut sender = LeaseRegistry::with_session_epoch(23);
        let (first, _) = sender.allocate(&vec![1; 256 * 1024]).unwrap();
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
