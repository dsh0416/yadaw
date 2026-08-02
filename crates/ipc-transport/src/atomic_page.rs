use super::*;

pub(crate) const SHARED_LAYOUT_VERSION: u64 = 1;
pub(crate) const HEADER_BYTES: usize = 128;
pub(crate) const OFFSET_MAGIC: usize = 0;
pub(crate) const OFFSET_LAYOUT_VERSION: usize = 8;
pub(crate) const OFFSET_EPOCH: usize = 16;
pub(crate) const OFFSET_CAPACITY: usize = 24;
pub(crate) const OFFSET_GENERATION: usize = 80;
pub(crate) const OFFSET_CHALLENGE: usize = 88;
pub(crate) const OFFSET_RESPONSE: usize = 96;

const CHALLENGE_SALT: u64 = 0x6d61_7070_696e_6721;
const RESPONSE_SALT: u64 = 0x7665_7269_6669_6564;

pub(crate) fn page_length(capacity: u32, slot_bytes: usize) -> Result<usize, TransportError> {
    usize::try_from(capacity)
        .ok()
        .and_then(|value| value.checked_mul(slot_bytes))
        .and_then(|slots| HEADER_BYTES.checked_add(slots))
        .filter(|length| *length <= MAX_MESSAGE_BYTES)
        .ok_or(TransportError::InvalidCapacity)
}

pub(crate) fn validate_page(
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
    if page.load_u64(OFFSET_GENERATION, Ordering::Acquire) != page.generation() {
        return Err(TransportError::InvalidSharedLayout);
    }
    let challenge = page.load_u64(OFFSET_CHALLENGE, Ordering::Acquire);
    if challenge == 0 {
        return Err(TransportError::InvalidSharedLayout);
    }
    Ok(())
}

pub(crate) fn initialize_page(page: &AtomicPage<'_>, magic: u64, capacity: u32, epoch: u64) {
    page.store_u64(OFFSET_MAGIC, magic, Ordering::Relaxed);
    page.store_u64(
        OFFSET_LAYOUT_VERSION,
        SHARED_LAYOUT_VERSION,
        Ordering::Relaxed,
    );
    page.store_u64(OFFSET_EPOCH, epoch, Ordering::Relaxed);
    page.store_u64(OFFSET_GENERATION, page.generation(), Ordering::Relaxed);
    page.store_u64(
        OFFSET_CHALLENGE,
        mapping_challenge(epoch, page.generation(), magic),
        Ordering::Relaxed,
    );
    page.store_u64(OFFSET_RESPONSE, 0, Ordering::Relaxed);
    page.store_u64(OFFSET_CAPACITY, u64::from(capacity), Ordering::Release);
}

pub(crate) struct AtomicPage<'a> {
    address: std::ptr::NonNull<u8>,
    length: usize,
    generation: u64,
    _mapping: std::marker::PhantomData<&'a ()>,
}

impl<'a> AtomicPage<'a> {
    pub(crate) fn new(memory: &'a impl AtomicMemory) -> Self {
        Self {
            address: memory.atomic_address(),
            length: memory.atomic_length(),
            generation: memory.atomic_generation(),
            _mapping: std::marker::PhantomData,
        }
    }

    pub(crate) const fn len(&self) -> usize {
        self.length
    }

    pub(crate) const fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn acknowledge_mapping(&self) {
        let challenge = self.load_u64(OFFSET_CHALLENGE, Ordering::Acquire);
        self.store_u64(
            OFFSET_RESPONSE,
            mapping_response(challenge),
            Ordering::Release,
        );
    }

    pub(crate) fn peer_verified(&self) -> bool {
        let challenge = self.load_u64(OFFSET_CHALLENGE, Ordering::Acquire);
        challenge != 0
            && self.load_u64(OFFSET_RESPONSE, Ordering::Acquire) == mapping_response(challenge)
    }

    pub(crate) fn atomic_u32(&self, offset: usize) -> &AtomicU32 {
        debug_assert_eq!(offset % align_of::<AtomicU32>(), 0);
        debug_assert!(offset + size_of::<AtomicU32>() <= self.len());
        // SAFETY: SharedMemory mappings are page-aligned and remain alive for
        // this borrow. The checked fixed ABI offsets are naturally aligned and
        // accessed exclusively through AtomicU32 in every process.
        unsafe { AtomicU32::from_ptr(self.address.as_ptr().add(offset).cast::<u32>()) }
    }

    pub(crate) fn atomic_u64(&self, offset: usize) -> &AtomicU64 {
        debug_assert_eq!(offset % align_of::<AtomicU64>(), 0);
        debug_assert!(offset + size_of::<AtomicU64>() <= self.len());
        // SAFETY: See `atomic_u32`; the fixed ABI guarantees 64-bit alignment.
        unsafe { AtomicU64::from_ptr(self.address.as_ptr().add(offset).cast::<u64>()) }
    }

    pub(crate) fn load_u32(&self, offset: usize, ordering: Ordering) -> u32 {
        self.atomic_u32(offset).load(ordering)
    }

    pub(crate) fn store_u32(&self, offset: usize, value: u32, ordering: Ordering) {
        self.atomic_u32(offset).store(value, ordering);
    }

    pub(crate) fn load_u64(&self, offset: usize, ordering: Ordering) -> u64 {
        self.atomic_u64(offset).load(ordering)
    }

    pub(crate) fn store_u64(&self, offset: usize, value: u64, ordering: Ordering) {
        self.atomic_u64(offset).store(value, ordering);
    }

    pub(crate) fn fetch_add_u64(&self, offset: usize, value: u64, ordering: Ordering) -> u64 {
        self.atomic_u64(offset).fetch_add(value, ordering)
    }
}

pub(crate) trait AtomicMemory {
    fn atomic_address(&self) -> std::ptr::NonNull<u8>;
    fn atomic_length(&self) -> usize;
    fn atomic_generation(&self) -> u64;
}

impl AtomicMemory for SharedMemory {
    fn atomic_address(&self) -> std::ptr::NonNull<u8> {
        // SAFETY: AtomicPage ties the raw address to the mapping borrow and
        // exposes only checked, naturally aligned atomic field operations.
        unsafe { self.address() }
    }

    fn atomic_length(&self) -> usize {
        self.len().get()
    }

    fn atomic_generation(&self) -> u64 {
        self.descriptor().generation()
    }
}

fn mapping_challenge(epoch: u64, generation: u64, magic: u64) -> u64 {
    let value = epoch.rotate_left(17) ^ generation.rotate_right(11) ^ magic ^ CHALLENGE_SALT;
    if value == 0 { CHALLENGE_SALT } else { value }
}

fn mapping_response(challenge: u64) -> u64 {
    challenge.rotate_left(29) ^ RESPONSE_SALT
}
