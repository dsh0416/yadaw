use super::*;

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

#[derive(Debug, Clone, Copy)]
pub(crate) struct LeaseEntry {
    region_index: usize,
    slot: usize,
    allocation_generation: u64,
    offset: usize,
    bytes: usize,
    pub(crate) created_at: Instant,
}

pub struct LeaseRegistry {
    session_epoch: u64,
    next_id: u64,
    next_region_id: u32,
    pub(crate) entries: HashMap<u64, LeaseEntry>,
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

    pub(crate) fn allocate(
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
