use super::*;

pub(crate) const SHARED_LAYOUT_VERSION: u64 = 1;
pub(crate) const HEADER_BYTES: usize = 128;
pub(crate) const OFFSET_MAGIC: usize = 0;
pub(crate) const OFFSET_LAYOUT_VERSION: usize = 8;
pub(crate) const OFFSET_EPOCH: usize = 16;
pub(crate) const OFFSET_CAPACITY: usize = 24;

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
    Ok(())
}

pub(crate) struct AtomicPage<'a> {
    bytes: &'a [u8],
}

impl<'a> AtomicPage<'a> {
    pub(crate) fn new(memory: &'a IpcSharedMemory) -> Self {
        Self { bytes: memory }
    }

    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn atomic_u32(&self, offset: usize) -> &AtomicU32 {
        debug_assert_eq!(offset % align_of::<AtomicU32>(), 0);
        debug_assert!(offset + size_of::<AtomicU32>() <= self.bytes.len());
        // SAFETY: IpcSharedMemory mappings are page-aligned and remain alive for
        // this borrow. Every shared field is naturally aligned and is accessed
        // exclusively through the matching atomic type in both processes.
        unsafe { &*self.bytes.as_ptr().add(offset).cast::<AtomicU32>() }
    }

    pub(crate) fn atomic_u64(&self, offset: usize) -> &AtomicU64 {
        debug_assert_eq!(offset % align_of::<AtomicU64>(), 0);
        debug_assert!(offset + size_of::<AtomicU64>() <= self.bytes.len());
        // SAFETY: See `atomic_u32`; the fixed ABI guarantees 64-bit alignment.
        unsafe { &*self.bytes.as_ptr().add(offset).cast::<AtomicU64>() }
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
