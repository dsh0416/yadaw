use std::{
    collections::{BTreeMap, VecDeque},
    fs::{File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::Path,
};

use crate::midi::{NormalizedMidiEvent, NormalizedMidiEventKind, NormalizedMidiNote};
use crate::midi_input::{MidiInputMessage, MidiInputParser};

const MAGIC: &[u8; 8] = b"YDMIDIJ1";
const VERSION: u16 = 1;
const MAX_RECORD_BYTES: usize = 1024 * 1024 + 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MidiJournalHeader {
    pub source_id: String,
    pub clip_id: String,
    pub track_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MidiJournalRecord {
    pub timestamp_micros: u64,
    pub transport_frame: Option<u64>,
    pub transport_tick: Option<u64>,
    pub port_key: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveredMidiJournal {
    pub header: MidiJournalHeader,
    pub records: Vec<MidiJournalRecord>,
    pub ignored_corrupt_tail: bool,
}

pub struct MidiJournalWriter {
    writer: BufWriter<File>,
}

impl MidiJournalWriter {
    pub fn create(path: impl AsRef<Path>, header: &MidiJournalHeader) -> io::Result<Self> {
        let mut writer =
            BufWriter::new(OpenOptions::new().create_new(true).write(true).open(path)?);
        writer.write_all(MAGIC)?;
        writer.write_all(&VERSION.to_le_bytes())?;
        write_string(&mut writer, &header.source_id)?;
        write_string(&mut writer, &header.clip_id)?;
        write_string(&mut writer, &header.track_id)?;
        writer.flush()?;
        Ok(Self { writer })
    }

    pub fn append(&mut self, record: &MidiJournalRecord) -> io::Result<()> {
        let mut payload = Vec::with_capacity(41 + record.bytes.len());
        payload.extend_from_slice(&record.timestamp_micros.to_le_bytes());
        encode_checkpoint(&mut payload, record.transport_frame);
        encode_checkpoint(&mut payload, record.transport_tick);
        payload.extend_from_slice(&record.port_key.to_le_bytes());
        let byte_count = u32::try_from(record.bytes.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "MIDI record is too large"))?;
        payload.extend_from_slice(&byte_count.to_le_bytes());
        payload.extend_from_slice(&record.bytes);
        if payload.len() > MAX_RECORD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "MIDI record exceeds journal limit",
            ));
        }
        self.writer
            .write_all(&(payload.len() as u32).to_le_bytes())?;
        self.writer.write_all(&checksum(&payload).to_le_bytes())?;
        self.writer.write_all(&payload)
    }

    pub fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

pub fn recover_midi_journal(path: impl AsRef<Path>) -> io::Result<RecoveredMidiJournal> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut magic = [0_u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid MIDI journal magic",
        ));
    }
    let version = read_u16(&mut reader)?;
    if version != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported MIDI journal version",
        ));
    }
    let header = MidiJournalHeader {
        source_id: read_string(&mut reader)?,
        clip_id: read_string(&mut reader)?,
        track_id: read_string(&mut reader)?,
    };
    let mut records = Vec::new();
    let mut ignored_corrupt_tail = false;
    loop {
        let mut prefix = [0_u8; 8];
        match reader.read(&mut prefix[..1]) {
            Ok(0) => break,
            Ok(1) => {}
            Ok(_) => unreachable!(),
            Err(error) => return Err(error),
        }
        match reader.read_exact(&mut prefix[1..]) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                ignored_corrupt_tail = true;
                break;
            }
            Err(error) => return Err(error),
        }
        let length = u32::from_le_bytes(prefix[..4].try_into().unwrap_or_default()) as usize;
        let expected_checksum = u32::from_le_bytes(prefix[4..].try_into().unwrap_or_default());
        if length == 0 || length > MAX_RECORD_BYTES {
            ignored_corrupt_tail = true;
            break;
        }
        let mut payload = vec![0_u8; length];
        if reader.read_exact(&mut payload).is_err() || checksum(&payload) != expected_checksum {
            ignored_corrupt_tail = true;
            break;
        }
        let Some(record) = decode_record(&payload) else {
            ignored_corrupt_tail = true;
            break;
        };
        records.push(record);
    }
    Ok(RecoveredMidiJournal {
        header,
        records,
        ignored_corrupt_tail,
    })
}

fn encode_checkpoint(payload: &mut Vec<u8>, value: Option<u64>) {
    payload.push(u8::from(value.is_some()));
    payload.extend_from_slice(&value.unwrap_or_default().to_le_bytes());
}

fn decode_record(payload: &[u8]) -> Option<MidiJournalRecord> {
    if payload.len() < 38 {
        return None;
    }
    let mut cursor = 0;
    let timestamp_micros = take_u64(payload, &mut cursor)?;
    let transport_frame = take_checkpoint(payload, &mut cursor)?;
    let transport_tick = take_checkpoint(payload, &mut cursor)?;
    let port_key = take_u64(payload, &mut cursor)?;
    let byte_count = take_u32(payload, &mut cursor)? as usize;
    let end = cursor.checked_add(byte_count)?;
    let bytes = payload.get(cursor..end)?.to_vec();
    (end == payload.len()).then_some(MidiJournalRecord {
        timestamp_micros,
        transport_frame,
        transport_tick,
        port_key,
        bytes,
    })
}

fn take_checkpoint(payload: &[u8], cursor: &mut usize) -> Option<Option<u64>> {
    let present = *payload.get(*cursor)?;
    *cursor += 1;
    let value = take_u64(payload, cursor)?;
    match present {
        0 => Some(None),
        1 => Some(Some(value)),
        _ => None,
    }
}

fn take_u64(payload: &[u8], cursor: &mut usize) -> Option<u64> {
    let end = cursor.checked_add(8)?;
    let bytes: [u8; 8] = payload.get(*cursor..end)?.try_into().ok()?;
    *cursor = end;
    Some(u64::from_le_bytes(bytes))
}

fn take_u32(payload: &[u8], cursor: &mut usize) -> Option<u32> {
    let end = cursor.checked_add(4)?;
    let bytes: [u8; 4] = payload.get(*cursor..end)?.try_into().ok()?;
    *cursor = end;
    Some(u32::from_le_bytes(bytes))
}

fn write_string(writer: &mut impl Write, value: &str) -> io::Result<()> {
    let length = u16::try_from(value.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "journal ID is too long"))?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(value.as_bytes())
}

fn read_string(reader: &mut impl Read) -> io::Result<String> {
    let length = read_u16(reader)? as usize;
    let mut bytes = vec![0_u8; length];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "journal ID is not UTF-8"))
}

fn read_u16(reader: &mut impl Read) -> io::Result<u16> {
    let mut bytes = [0_u8; 2];
    reader.read_exact(&mut bytes)?;
    Ok(u16::from_le_bytes(bytes))
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5, |value, byte| {
        (value ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MidiJournalTake {
    pub header: MidiJournalHeader,
    pub notes: Vec<NormalizedMidiNote>,
    pub events: Vec<NormalizedMidiEvent>,
    pub length_ticks: u64,
    pub warnings: Vec<String>,
    pub ignored_corrupt_tail: bool,
}

/// Convert a recovered journal into clip-local notes/events.
///
/// `start_tick` is subtracted from absolute transport ticks so clip content is
/// relative to the take origin. Unfinished notes are closed at the last
/// observed tick (or zero) with release velocity 0.
pub fn journal_records_to_take(
    recovered: &RecoveredMidiJournal,
    start_tick: u64,
) -> MidiJournalTake {
    let mut open_notes: BTreeMap<(u8, u8), VecDeque<(u64, u8)>> = BTreeMap::new();
    let mut notes = Vec::new();
    let mut events = Vec::new();
    let mut warnings = Vec::new();
    let mut last_tick = 0_u64;
    let mut parser = MidiInputParser::default();
    let mut first_timestamp = None;

    for record in &recovered.records {
        let Some(tick) = record_tick(record, start_tick, &mut first_timestamp) else {
            warnings.push("Ignored MIDI journal record without a resolvable tick".to_owned());
            continue;
        };
        last_tick = last_tick.max(tick);
        let Ok(messages) = parser.push(&record.bytes) else {
            warnings.push("Ignored undecodable MIDI journal record".to_owned());
            continue;
        };
        for message in messages {
            apply_recordable_message(
                &message,
                tick,
                &mut open_notes,
                &mut notes,
                &mut events,
                &mut warnings,
                &mut last_tick,
            );
        }
    }

    for ((channel, key), pending) in open_notes {
        for (note_start, velocity) in pending {
            notes.push(NormalizedMidiNote {
                start_tick: note_start,
                duration_ticks: last_tick.saturating_sub(note_start).max(1),
                channel,
                key,
                velocity,
                release_velocity: 0,
            });
            warnings.push(format!(
                "Closed unterminated note {key} on channel {} at take end",
                channel + 1
            ));
        }
    }

    notes.sort_by_key(|note| (note.start_tick, note.channel, note.key));
    events.sort_by_key(|event| event.tick);
    let length_ticks = notes
        .iter()
        .map(|note| note.start_tick.saturating_add(note.duration_ticks))
        .chain(events.iter().map(|event| event.tick.saturating_add(1)))
        .max()
        .unwrap_or(last_tick)
        .max(1);

    MidiJournalTake {
        header: recovered.header.clone(),
        notes,
        events,
        length_ticks,
        warnings,
        ignored_corrupt_tail: recovered.ignored_corrupt_tail,
    }
}

fn record_tick(
    record: &MidiJournalRecord,
    start_tick: u64,
    first_timestamp: &mut Option<u64>,
) -> Option<u64> {
    if let Some(tick) = record.transport_tick {
        return Some(tick.saturating_sub(start_tick));
    }
    let first = *first_timestamp.get_or_insert(record.timestamp_micros);
    let elapsed_micros = record.timestamp_micros.saturating_sub(first);
    // Fallback when transport checkpoints are missing: assume 120 BPM / 960 PPQ.
    let ticks = elapsed_micros.saturating_mul(960) / 500_000;
    Some(ticks)
}

fn apply_recordable_message(
    message: &MidiInputMessage,
    tick: u64,
    open_notes: &mut BTreeMap<(u8, u8), VecDeque<(u64, u8)>>,
    notes: &mut Vec<NormalizedMidiNote>,
    events: &mut Vec<NormalizedMidiEvent>,
    warnings: &mut Vec<String>,
    last_tick: &mut u64,
) {
    *last_tick = (*last_tick).max(tick);
    match *message {
        MidiInputMessage::NoteOn(channel, key, velocity) if velocity > 0 => {
            open_notes
                .entry((channel, key))
                .or_default()
                .push_back((tick, velocity));
        }
        MidiInputMessage::NoteOn(channel, key, _) | MidiInputMessage::NoteOff(channel, key, _) => {
            let release_velocity = match *message {
                MidiInputMessage::NoteOff(_, _, velocity) => velocity,
                _ => 0,
            };
            let pending = open_notes.get_mut(&(channel, key));
            let Some((start_tick, velocity)) = pending.and_then(VecDeque::pop_front) else {
                warnings.push(format!(
                    "Ignored unmatched note-off {key} on channel {}",
                    channel + 1
                ));
                return;
            };
            notes.push(NormalizedMidiNote {
                start_tick,
                duration_ticks: tick.saturating_sub(start_tick).max(1),
                channel,
                key,
                velocity,
                release_velocity,
            });
        }
        MidiInputMessage::ControlChange(channel, controller, value) => {
            events.push(NormalizedMidiEvent {
                tick,
                channel: Some(channel),
                kind: NormalizedMidiEventKind::ControlChange,
                data: vec![controller, value],
            });
        }
        MidiInputMessage::PitchBend(channel, value) => {
            let bend = i16::try_from(i32::from(value) - 8_192).unwrap_or(0);
            events.push(NormalizedMidiEvent {
                tick,
                channel: Some(channel),
                kind: NormalizedMidiEventKind::PitchBend,
                data: bend.to_le_bytes().to_vec(),
            });
        }
        MidiInputMessage::ProgramChange(channel, program) => {
            events.push(NormalizedMidiEvent {
                tick,
                channel: Some(channel),
                kind: NormalizedMidiEventKind::ProgramChange,
                data: vec![program],
            });
        }
        MidiInputMessage::ChannelPressure(channel, pressure) => {
            events.push(NormalizedMidiEvent {
                tick,
                channel: Some(channel),
                kind: NormalizedMidiEventKind::ChannelPressure,
                data: vec![pressure],
            });
        }
        MidiInputMessage::PolyPressure(channel, key, pressure) => {
            events.push(NormalizedMidiEvent {
                tick,
                channel: Some(channel),
                kind: NormalizedMidiEventKind::PolyPressure,
                data: vec![key, pressure],
            });
        }
        MidiInputMessage::SysEx(ref bytes) => {
            events.push(NormalizedMidiEvent {
                tick,
                channel: None,
                kind: NormalizedMidiEventKind::SysEx,
                data: bytes.clone(),
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::OpenOptions,
        io::Write,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "yadaw-{label}-{}-{}.midijournal",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    fn sample_header() -> MidiJournalHeader {
        MidiJournalHeader {
            source_id: "source".to_owned(),
            clip_id: "clip".to_owned(),
            track_id: "track".to_owned(),
        }
    }

    fn sample_record(
        timestamp_micros: u64,
        transport_frame: Option<u64>,
        transport_tick: Option<u64>,
        bytes: Vec<u8>,
    ) -> MidiJournalRecord {
        MidiJournalRecord {
            timestamp_micros,
            transport_frame,
            transport_tick,
            port_key: 7,
            bytes,
        }
    }

    fn append_raw_tail(path: &Path, bytes: &[u8]) {
        OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }

    #[test]
    fn converts_timestamp_fallback_and_event_kinds() {
        let recovered = RecoveredMidiJournal {
            header: sample_header(),
            records: vec![
                sample_record(1_000_000, None, None, vec![0x90, 60, 100]),
                sample_record(1_500_000, None, None, vec![0x80, 60, 10]),
                sample_record(1_500_000, None, None, vec![0xe0, 0x00, 0x40]),
                sample_record(1_500_000, None, None, vec![0xc0, 12]),
                sample_record(1_500_000, None, None, vec![0xd0, 77]),
                sample_record(1_500_000, None, None, vec![0xa0, 61, 40]),
                sample_record(1_500_000, None, None, vec![0xf0, 1, 2, 0xf7]),
            ],
            ignored_corrupt_tail: true,
        };
        let take = journal_records_to_take(&recovered, 0);
        assert_eq!(take.notes.len(), 1);
        assert_eq!(take.notes[0].start_tick, 0);
        assert_eq!(take.notes[0].duration_ticks, 960);
        assert_eq!(take.events.len(), 5);
        assert!(take.events.iter().any(|event| event.kind
            == crate::midi::NormalizedMidiEventKind::PitchBend
            && event.data == 0_i16.to_le_bytes()));
        assert!(take.events.iter().any(|event| event.kind
            == crate::midi::NormalizedMidiEventKind::ProgramChange
            && event.data == [12]));
        assert!(take.events.iter().any(|event| event.kind
            == crate::midi::NormalizedMidiEventKind::ChannelPressure
            && event.data == [77]));
        assert!(take.events.iter().any(|event| event.kind
            == crate::midi::NormalizedMidiEventKind::PolyPressure
            && event.data == [61, 40]));
        assert!(take.events.iter().any(|event| event.kind
            == crate::midi::NormalizedMidiEventKind::SysEx
            && event.data == [1, 2]));
        assert!(take.ignored_corrupt_tail);
    }

    #[test]
    fn conversion_warns_on_unmatched_note_off_and_bad_bytes() {
        let recovered = RecoveredMidiJournal {
            header: sample_header(),
            records: vec![
                // Data bytes before any status must fail without running status.
                sample_record(1, Some(0), Some(0), vec![0x20, 0x30]),
                sample_record(2, Some(0), Some(100), vec![0x80, 60, 40]),
            ],
            ignored_corrupt_tail: false,
        };
        let take = journal_records_to_take(&recovered, 0);
        assert!(take.notes.is_empty());
        assert!(
            take.warnings
                .iter()
                .any(|warning| warning.contains("undecodable"))
        );
        assert!(
            take.warnings
                .iter()
                .any(|warning| warning.contains("unmatched note-off"))
        );
    }

    #[test]
    fn conversion_pairs_stacked_notes_fifo_and_empty_take_has_unit_length() {
        let stacked = RecoveredMidiJournal {
            header: sample_header(),
            records: vec![
                sample_record(1, Some(0), Some(0), vec![0x90, 60, 10]),
                sample_record(2, Some(0), Some(100), vec![0x90, 60, 20]),
                sample_record(3, Some(0), Some(200), vec![0x80, 60, 1]),
                sample_record(4, Some(0), Some(400), vec![0x80, 60, 2]),
            ],
            ignored_corrupt_tail: false,
        };
        let take = journal_records_to_take(&stacked, 0);
        assert_eq!(take.notes.len(), 2);
        assert_eq!(take.notes[0].duration_ticks, 200);
        assert_eq!(take.notes[0].velocity, 10);
        assert_eq!(take.notes[0].release_velocity, 1);
        assert_eq!(take.notes[1].duration_ticks, 300);
        assert_eq!(take.notes[1].velocity, 20);
        assert_eq!(take.notes[1].release_velocity, 2);

        let empty = RecoveredMidiJournal {
            header: sample_header(),
            records: Vec::new(),
            ignored_corrupt_tail: false,
        };
        let empty_take = journal_records_to_take(&empty, 0);
        assert!(empty_take.notes.is_empty());
        assert!(empty_take.events.is_empty());
        assert_eq!(empty_take.length_ticks, 1);
    }

    #[test]
    fn converts_journal_records_into_notes_and_closes_unterminated() {
        let path = path("journal-to-take");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&sample_record(1, Some(0), Some(960), vec![0x90, 60, 100]))
            .unwrap();
        writer
            .append(&sample_record(2, Some(0), Some(1_920), vec![0x80, 60, 40]))
            .unwrap();
        writer
            .append(&sample_record(3, Some(0), Some(2_400), vec![0x90, 64, 90]))
            .unwrap();
        writer
            .append(&sample_record(4, Some(0), Some(2_880), vec![0xb0, 7, 100]))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);

        let recovered = recover_midi_journal(&path).unwrap();
        let take = journal_records_to_take(&recovered, 960);
        assert_eq!(take.notes.len(), 2);
        assert_eq!(take.notes[0].start_tick, 0);
        assert_eq!(take.notes[0].duration_ticks, 960);
        assert_eq!(take.notes[0].release_velocity, 40);
        assert_eq!(take.notes[1].start_tick, 1_440);
        assert_eq!(take.notes[1].duration_ticks, 480);
        assert_eq!(take.notes[1].release_velocity, 0);
        assert_eq!(take.events.len(), 1);
        assert_eq!(
            take.events[0].kind,
            crate::midi::NormalizedMidiEventKind::ControlChange
        );
        assert!(
            take.warnings
                .iter()
                .any(|warning| warning.contains("unterminated"))
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn round_trips_checkpoints_and_raw_timestamps() {
        let path = path("journal-round-trip");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&sample_record(
                42,
                Some(480),
                Some(960),
                vec![0x90, 60, 100],
            ))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.header, header);
        assert_eq!(recovered.records.len(), 1);
        assert!(!recovered.ignored_corrupt_tail);
        assert_eq!(recovered.records[0].transport_tick, Some(960));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn round_trips_multiple_records_with_none_checkpoints() {
        let path = path("journal-multi-none");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        let first = sample_record(10, None, None, vec![0x90, 60, 100]);
        let second = sample_record(20, None, None, vec![0x80, 60, 0]);
        let third = sample_record(30, None, None, vec![0xb0, 1, 64]);
        writer.append(&first).unwrap();
        writer.append(&second).unwrap();
        writer.append(&third).unwrap();
        writer.flush().unwrap();
        drop(writer);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.header, header);
        assert!(!recovered.ignored_corrupt_tail);
        assert_eq!(recovered.records, vec![first, second, third]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ignores_a_truncated_or_corrupt_tail() {
        let path = path("journal-tail");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&sample_record(1, None, None, vec![0xb0, 1, 64]))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);
        append_raw_tail(&path, &[20, 0, 0, 0, 1, 2, 3]);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records.len(), 1);
        assert!(recovered.ignored_corrupt_tail);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_invalid_magic() {
        let path = path("journal-bad-magic");
        std::fs::write(&path, b"BADMAGIC\x01\x00").unwrap();
        let error = recover_midi_journal(&path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("magic"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_version() {
        let path = path("journal-bad-version");
        let mut file = File::create(&path).unwrap();
        file.write_all(MAGIC).unwrap();
        file.write_all(&2_u16.to_le_bytes()).unwrap();
        write_string(&mut file, "source").unwrap();
        write_string(&mut file, "clip").unwrap();
        write_string(&mut file, "track").unwrap();
        drop(file);

        let error = recover_midi_journal(&path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("version"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_invalid_utf8_id() {
        let path = path("journal-bad-utf8");
        let mut file = File::create(&path).unwrap();
        file.write_all(MAGIC).unwrap();
        file.write_all(&VERSION.to_le_bytes()).unwrap();
        file.write_all(&2_u16.to_le_bytes()).unwrap();
        file.write_all(&[0xff, 0xff]).unwrap();
        drop(file);

        let error = recover_midi_journal(&path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("UTF-8"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_id_that_is_too_long_on_write() {
        let path = path("journal-long-id");
        let too_long = "x".repeat(usize::from(u16::MAX) + 1);
        let header = MidiJournalHeader {
            source_id: too_long,
            clip_id: "clip".to_owned(),
            track_id: "track".to_owned(),
        };
        let error = match MidiJournalWriter::create(&path, &header) {
            Ok(_) => panic!("oversized journal ID must fail"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("too long"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_record_that_exceeds_journal_limit() {
        let path = path("journal-huge-record");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        let error = writer
            .append(&sample_record(1, None, None, vec![0; MAX_RECORD_BYTES]))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("exceeds journal limit"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn corrupt_checksum_mid_stream_keeps_prior_records() {
        let path = path("journal-bad-checksum");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        let first = sample_record(1, Some(10), Some(20), vec![0x90, 60, 100]);
        let second = sample_record(2, None, None, vec![0x80, 60, 0]);
        writer.append(&first).unwrap();
        writer.append(&second).unwrap();
        writer.flush().unwrap();
        drop(writer);

        let mut payload = Vec::new();
        payload.extend_from_slice(&3_u64.to_le_bytes());
        encode_checkpoint(&mut payload, None);
        encode_checkpoint(&mut payload, None);
        payload.extend_from_slice(&9_u64.to_le_bytes());
        payload.extend_from_slice(&3_u32.to_le_bytes());
        payload.extend_from_slice(&[0x90, 61, 100]);
        let mut tail = Vec::new();
        tail.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        tail.extend_from_slice(&0xdead_beef_u32.to_le_bytes());
        tail.extend_from_slice(&payload);
        tail.extend_from_slice(&[1, 2, 3, 4]);
        append_raw_tail(&path, &tail);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records, vec![first, second]);
        assert!(recovered.ignored_corrupt_tail);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn zero_length_prefix_is_treated_as_corrupt_tail() {
        let path = path("journal-zero-len");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&sample_record(1, None, None, vec![0x90, 60, 100]))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);
        append_raw_tail(&path, &[0, 0, 0, 0, 0, 0, 0, 0]);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records.len(), 1);
        assert!(recovered.ignored_corrupt_tail);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn oversized_length_prefix_is_treated_as_corrupt_tail() {
        let path = path("journal-oversize-len");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&sample_record(1, None, None, vec![0x90, 60, 100]))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);
        let mut tail = Vec::new();
        tail.extend_from_slice(&((MAX_RECORD_BYTES as u32) + 1).to_le_bytes());
        tail.extend_from_slice(&0_u32.to_le_bytes());
        append_raw_tail(&path, &tail);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records.len(), 1);
        assert!(recovered.ignored_corrupt_tail);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn decode_record_rejects_truncated_payload() {
        assert!(decode_record(&[]).is_none());
        assert!(decode_record(&[0; 37]).is_none());

        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u64.to_le_bytes());
        encode_checkpoint(&mut payload, None);
        encode_checkpoint(&mut payload, None);
        payload.extend_from_slice(&2_u64.to_le_bytes());
        payload.extend_from_slice(&8_u32.to_le_bytes());
        payload.extend_from_slice(&[1, 2, 3]);
        assert!(decode_record(&payload).is_none());
    }

    #[test]
    fn decode_record_rejects_trailing_bytes_after_midi_payload() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1_u64.to_le_bytes());
        encode_checkpoint(&mut payload, Some(5));
        encode_checkpoint(&mut payload, Some(6));
        payload.extend_from_slice(&2_u64.to_le_bytes());
        payload.extend_from_slice(&3_u32.to_le_bytes());
        payload.extend_from_slice(&[0x90, 60, 100, 0xff]);
        assert!(decode_record(&payload).is_none());
    }

    #[test]
    fn truncated_payload_after_valid_prefix_is_corrupt_tail() {
        let path = path("journal-truncated-payload");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&sample_record(1, None, None, vec![0x90, 60, 100]))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);

        let mut payload = Vec::new();
        payload.extend_from_slice(&2_u64.to_le_bytes());
        encode_checkpoint(&mut payload, None);
        encode_checkpoint(&mut payload, None);
        payload.extend_from_slice(&3_u64.to_le_bytes());
        payload.extend_from_slice(&3_u32.to_le_bytes());
        payload.extend_from_slice(&[0x90, 60]);
        // Claim a longer length than the bytes we append so recovery hits EOF.
        let claimed_len = (payload.len() + 8) as u32;
        let mut tail = Vec::new();
        tail.extend_from_slice(&claimed_len.to_le_bytes());
        tail.extend_from_slice(&checksum(&payload).to_le_bytes());
        tail.extend_from_slice(&payload);
        append_raw_tail(&path, &tail);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records.len(), 1);
        assert!(recovered.ignored_corrupt_tail);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn decode_failure_after_checksum_match_is_corrupt_tail() {
        let path = path("journal-decode-fail");
        let header = sample_header();
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&sample_record(1, None, None, vec![0x90, 60, 100]))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);

        // Valid framing and checksum, but payload is too short for decode_record.
        let payload = vec![0_u8; 20];
        let mut tail = Vec::new();
        tail.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        tail.extend_from_slice(&checksum(&payload).to_le_bytes());
        tail.extend_from_slice(&payload);
        append_raw_tail(&path, &tail);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records.len(), 1);
        assert!(recovered.ignored_corrupt_tail);
        let _ = std::fs::remove_file(path);
    }
}
