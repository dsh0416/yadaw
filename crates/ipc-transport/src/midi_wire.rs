use super::*;

pub(crate) const MIDI_BATCH_LAYOUT_VERSION: u16 = 1;
pub(crate) const MIDI_NOTE_BATCH_MAGIC: [u8; 8] = *b"YADMN001";
pub(crate) const MIDI_EVENT_BATCH_MAGIC: [u8; 8] = *b"YADME001";

#[derive(Clone, Copy, FromBytes, Immutable, IntoBytes, KnownLayout, Unaligned)]
#[repr(C)]
pub(crate) struct MidiBatchHeader {
    pub(crate) magic: [u8; 8],
    pub(crate) layout_version: U16,
    pub(crate) header_bytes: U16,
    pub(crate) element_bytes: U16,
    pub(crate) flags: U16,
    pub(crate) element_count: U32,
    pub(crate) data_offset: U32,
    pub(crate) total_bytes: U64,
}

/// Stable, little-endian representation of one MIDI note in a shared batch.
#[derive(Clone, Copy, FromBytes, Immutable, IntoBytes, KnownLayout, Unaligned)]
#[repr(C)]
pub struct MidiNoteWire {
    start_tick: U64,
    duration_ticks: U64,
    pub(crate) channel: u8,
    key: u8,
    velocity: u8,
    release_velocity: u8,
    pub(crate) reserved: [u8; 4],
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
pub(crate) struct MidiEventWire {
    pub(crate) tick: U64,
    pub(crate) kind_offset: U32,
    pub(crate) kind_length: U32,
    pub(crate) data_offset: U64,
    pub(crate) data_length: U64,
    pub(crate) channel: u8,
    pub(crate) has_channel: u8,
    pub(crate) reserved: [u8; 6],
}

const _: () = assert!(size_of::<MidiBatchHeader>() == 32);
const _: () = assert!(size_of::<MidiNoteWire>() == 24);
const _: () = assert!(size_of::<MidiEventWire>() == 40);

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

pub(crate) fn parse_midi_notes(bytes: &[u8]) -> Result<&[MidiNoteWire], TransportError> {
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

pub(crate) fn parse_midi_events(bytes: &[u8]) -> Result<(&[MidiEventWire], &[u8]), TransportError> {
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
