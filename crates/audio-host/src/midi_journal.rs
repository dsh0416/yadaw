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
