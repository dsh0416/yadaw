use super::*;

const PARAMETER_MAGIC: u64 = 0x5941_4450_4152_4D32;
const PARAMETER_SLOT_BYTES: usize = 64;
const RING_OFFSET_HEAD: usize = 32;
const RING_OFFSET_TAIL: usize = 40;

const _: () = assert!(PARAMETER_SLOT_BYTES.is_multiple_of(align_of::<AtomicU64>()));

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
    page.store_u32(offset + 40, command.target_generation, Ordering::Relaxed);
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
        target_generation: page.load_u32(offset + 40, Ordering::Relaxed),
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
