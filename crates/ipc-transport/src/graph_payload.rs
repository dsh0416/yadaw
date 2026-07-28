use super::*;

pub(crate) fn validate_request_payloads(
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

pub(crate) fn materialize_binary(
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

pub(crate) fn extract_binary_attachment(
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
