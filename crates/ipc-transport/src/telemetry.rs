use super::*;

const TELEMETRY_MAGIC: u64 = 0x5941_4454_454C_4532;
const METER_SLOT_BYTES: usize = 64;
const OFFSET_SEQUENCE: usize = 32;
const OFFSET_GRAPH_REVISION: usize = 40;
const OFFSET_CALLBACK_GENERATION: usize = 48;
const OFFSET_POSITION_FRAMES: usize = 56;
const OFFSET_SAMPLE_RATE: usize = 64;
const OFFSET_TRANSPORT_STATE: usize = 68;
const OFFSET_METER_COUNT: usize = 72;

const _: () = assert!(HEADER_BYTES.is_multiple_of(align_of::<AtomicU64>()));
const _: () = assert!(METER_SLOT_BYTES.is_multiple_of(align_of::<AtomicU64>()));

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
