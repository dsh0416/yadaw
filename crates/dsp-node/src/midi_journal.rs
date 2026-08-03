use std::fs;

use heron_dsp_runtime::midi::NormalizedMidiEventKind;
use heron_dsp_runtime::midi_journal::{journal_records_to_take, recover_midi_journal};
use napi::{Error, Result, Status, bindgen_prelude::Buffer};
use napi_derive::napi;

use crate::midi::{NativeMidiEvent, NativeMidiNote};

#[napi(object)]
pub struct NativeMidiJournalTake {
    pub source_id: String,
    pub clip_id: String,
    pub track_id: String,
    pub notes: Vec<NativeMidiNote>,
    pub events: Vec<NativeMidiEvent>,
    pub length_ticks: i64,
    pub warnings: Vec<String>,
    pub ignored_corrupt_tail: bool,
}

#[napi]
pub fn recover_midi_journal_take(path: String, start_tick: i64) -> Result<NativeMidiJournalTake> {
    if start_tick < 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "MIDI take start tick must be non-negative",
        ));
    }
    let start_tick = u64::try_from(start_tick)
        .map_err(|_| Error::new(Status::InvalidArg, "MIDI take start tick is invalid"))?;
    if fs::metadata(&path).is_err() {
        return Err(Error::new(
            Status::GenericFailure,
            format!("MIDI journal was not found at {path}"),
        ));
    }
    let recovered = recover_midi_journal(&path)
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
    let take = journal_records_to_take(&recovered, start_tick);
    Ok(NativeMidiJournalTake {
        source_id: take.header.source_id,
        clip_id: take.header.clip_id,
        track_id: take.header.track_id,
        notes: take
            .notes
            .into_iter()
            .map(|note| {
                Ok(NativeMidiNote {
                    start_tick: i64::try_from(note.start_tick).map_err(|_| {
                        Error::new(Status::InvalidArg, "MIDI note start tick is out of range")
                    })?,
                    duration_ticks: i64::try_from(note.duration_ticks).map_err(|_| {
                        Error::new(Status::InvalidArg, "MIDI note duration is out of range")
                    })?,
                    channel: u32::from(note.channel),
                    key: u32::from(note.key),
                    velocity: u32::from(note.velocity),
                    release_velocity: u32::from(note.release_velocity),
                })
            })
            .collect::<Result<Vec<_>>>()?,
        events: take
            .events
            .into_iter()
            .map(|event| {
                Ok(NativeMidiEvent {
                    tick: i64::try_from(event.tick).map_err(|_| {
                        Error::new(Status::InvalidArg, "MIDI event tick is out of range")
                    })?,
                    channel: event.channel.map(u32::from),
                    kind: match event.kind {
                        NormalizedMidiEventKind::ControlChange => "control-change",
                        NormalizedMidiEventKind::PitchBend => "pitch-bend",
                        NormalizedMidiEventKind::ProgramChange => "program-change",
                        NormalizedMidiEventKind::ChannelPressure => "channel-pressure",
                        NormalizedMidiEventKind::PolyPressure => "poly-pressure",
                        NormalizedMidiEventKind::SysEx => "sysex",
                    }
                    .to_owned(),
                    data: Buffer::from(event.data),
                })
            })
            .collect::<Result<Vec<_>>>()?,
        length_ticks: i64::try_from(take.length_ticks)
            .map_err(|_| Error::new(Status::InvalidArg, "MIDI take length is out of range"))?,
        warnings: take.warnings,
        ignored_corrupt_tail: take.ignored_corrupt_tail,
    })
}
