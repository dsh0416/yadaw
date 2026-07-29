use super::*;

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

pub(crate) struct AttachmentBuilder<'a> {
    arena: &'a mut LeaseRegistry,
    offers: Vec<RegionOffer>,
    lease_ids: Vec<u64>,
    pub(crate) total_bytes: usize,
    committed: bool,
}

impl<'a> AttachmentBuilder<'a> {
    pub(crate) fn new(arena: &'a mut LeaseRegistry) -> Self {
        Self {
            arena,
            offers: Vec::new(),
            lease_ids: Vec::new(),
            total_bytes: 0,
            committed: false,
        }
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<SharedBlobRef, TransportError> {
        self.total_bytes = checked_packet_attachment_bytes(self.total_bytes, bytes.len())?;
        let (reference, offer) = self.arena.allocate(bytes)?;
        self.lease_ids.push(reference.lease_id);
        if let Some(offer) = offer {
            // One offer per region per packet; later allocations in the same
            // region replace the earlier handle so the snapshot includes them.
            if let Some(existing) = self
                .offers
                .iter_mut()
                .find(|value| value.region_id == offer.region_id)
            {
                *existing = offer;
            } else {
                self.offers.push(offer);
            }
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

pub(crate) fn checked_packet_attachment_bytes(
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

pub(crate) fn encoded_midi_notes(notes: &[LiveMidiNote]) -> Result<Vec<u8>, TransportError> {
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
            ara_document_state,
            ..
        } => {
            externalize_binary(component_state, &mut builder, &[])?;
            externalize_binary(controller_state, &mut builder, &[])?;
            externalize_binary(ara_document_state, &mut builder, &[])?;
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
            ara_document_state,
            ..
        } => {
            externalize_binary(component_state, &mut builder, attachments)?;
            externalize_binary(controller_state, &mut builder, attachments)?;
            externalize_binary(ara_document_state, &mut builder, attachments)?;
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
            ara_document_state,
        } => {
            externalize_binary(component_state, &mut builder, &[])?;
            externalize_binary(controller_state, &mut builder, &[])?;
            externalize_binary(ara_document_state, &mut builder, &[])?;
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
            ara_document_state,
        } => {
            externalize_binary_from_arena(component_state, &mut builder, source)?;
            externalize_binary_from_arena(controller_state, &mut builder, source)?;
            externalize_binary_from_arena(ara_document_state, &mut builder, source)?;
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
            ara_document_state,
            ..
        } => {
            materialize_binary(component_state, arena, &mut leases)?;
            materialize_binary(controller_state, arena, &mut leases)?;
            materialize_binary(ara_document_state, arena, &mut leases)?;
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
            ara_document_state,
        } => {
            materialize_binary(component_state, arena, &mut leases)?;
            materialize_binary(controller_state, arena, &mut leases)?;
            materialize_binary(ara_document_state, arena, &mut leases)?;
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
            ara_document_state,
        } => {
            extract_binary_attachment(component_state, arena, &mut attachments, &mut leases)?;
            extract_binary_attachment(controller_state, arena, &mut attachments, &mut leases)?;
            extract_binary_attachment(ara_document_state, arena, &mut attachments, &mut leases)?;
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
