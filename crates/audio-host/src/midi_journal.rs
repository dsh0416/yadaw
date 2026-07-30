use std::{
    fs::{File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::Path,
};

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::OpenOptions,
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

    #[test]
    fn round_trips_checkpoints_and_raw_timestamps() {
        let path = path("journal-round-trip");
        let header = MidiJournalHeader {
            source_id: "source".to_owned(),
            clip_id: "clip".to_owned(),
            track_id: "track".to_owned(),
        };
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&MidiJournalRecord {
                timestamp_micros: 42,
                transport_frame: Some(480),
                transport_tick: Some(960),
                port_key: 7,
                bytes: vec![0x90, 60, 100],
            })
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
    fn ignores_a_truncated_or_corrupt_tail() {
        let path = path("journal-tail");
        let header = MidiJournalHeader {
            source_id: "source".to_owned(),
            clip_id: "clip".to_owned(),
            track_id: "track".to_owned(),
        };
        let mut writer = MidiJournalWriter::create(&path, &header).unwrap();
        writer
            .append(&MidiJournalRecord {
                timestamp_micros: 1,
                transport_frame: None,
                transport_tick: None,
                port_key: 2,
                bytes: vec![0xb0, 1, 64],
            })
            .unwrap();
        writer.flush().unwrap();
        drop(writer);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[20, 0, 0, 0, 1, 2, 3])
            .unwrap();

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records.len(), 1);
        assert!(recovered.ignored_corrupt_tail);
        let _ = std::fs::remove_file(path);
    }
}
