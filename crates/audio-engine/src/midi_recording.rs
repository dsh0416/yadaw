use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
};

use yadaw_dsp_runtime::{
    midi_input::MidiInputMessage,
    midi_journal::{MidiJournalHeader, MidiJournalRecord, MidiJournalWriter},
    protocol::{
        MidiRecordingPreview, MidiRecordingPreviewNote, MidiRecordingStartConfig,
        MidiRecordingTakePreview, MidiRecordingTakeResult,
    },
};

use crate::TransportClockHandle;
use crate::midi_input::stable_port_key;

struct ActiveMidiTake {
    path: String,
    source_id: String,
    clip_id: String,
    track_id: String,
    port_key: Option<u64>,
    channel: Option<u8>,
    writer: MidiJournalWriter,
    event_count: u64,
    dropped_events: u64,
    next_preview_note_id: u64,
    preview_notes: Vec<PreviewNote>,
    open_preview_notes: BTreeMap<(u8, u8), VecDeque<usize>>,
}

struct PreviewNote {
    id: u64,
    start_tick: u64,
    end_tick: Option<u64>,
    channel: u8,
    key: u8,
    velocity: u8,
}

pub struct MidiRecordingSession {
    takes: Vec<ActiveMidiTake>,
    transport_state: Arc<AtomicU32>,
    position_frames: Arc<AtomicU64>,
    position_ticks: Arc<AtomicU64>,
    recording_state: u32,
}

impl MidiRecordingSession {
    pub fn start(
        config: MidiRecordingStartConfig,
        clock: TransportClockHandle,
    ) -> Result<Self, String> {
        if config.takes.is_empty() {
            return Err("MIDI recording requires at least one take".to_owned());
        }
        let mut takes = Vec::with_capacity(config.takes.len());
        for take in config.takes {
            if take.path.is_empty()
                || take.source_id.is_empty()
                || take.clip_id.is_empty()
                || take.track_id.is_empty()
            {
                return Err("MIDI recording take fields must be non-empty".to_owned());
            }
            if take.channel.is_some_and(|channel| channel > 15) {
                return Err("MIDI recording channel must be between 0 and 15".to_owned());
            }
            let header = MidiJournalHeader {
                source_id: take.source_id.clone(),
                clip_id: take.clip_id.clone(),
                track_id: take.track_id.clone(),
            };
            let writer = MidiJournalWriter::create(&take.path, &header)
                .map_err(|error| format!("failed to create MIDI journal: {error}"))?;
            takes.push(ActiveMidiTake {
                path: take.path,
                source_id: take.source_id,
                clip_id: take.clip_id,
                track_id: take.track_id,
                port_key: take.port_id.as_deref().map(stable_port_key),
                channel: take.channel,
                writer,
                event_count: 0,
                dropped_events: 0,
                next_preview_note_id: 0,
                preview_notes: Vec::new(),
                open_preview_notes: BTreeMap::new(),
            });
        }
        Ok(Self {
            takes,
            transport_state: clock.state,
            position_frames: clock.position_frames,
            position_ticks: clock.position_ticks,
            recording_state: clock.recording_state,
        })
    }

    pub fn observe(&mut self, timestamp_micros: u64, port_key: u64, message: &MidiInputMessage) {
        if !message.is_recordable() {
            return;
        }
        if self.transport_state.load(Ordering::Relaxed) != self.recording_state {
            // Count-in / waiting / stopped: keep journals open but do not append.
            return;
        }
        let channel = message.channel();
        let transport_frame = Some(self.position_frames.load(Ordering::Relaxed));
        let transport_tick = self.position_ticks.load(Ordering::Relaxed);
        let bytes = message.encode();
        for take in &mut self.takes {
            if take.port_key.is_some_and(|expected| expected != port_key) {
                continue;
            }
            if take.channel.is_some() && take.channel != channel {
                continue;
            }
            let record = MidiJournalRecord {
                timestamp_micros,
                transport_frame,
                transport_tick: Some(transport_tick),
                port_key,
                bytes: bytes.clone(),
            };
            match take.writer.append(&record) {
                Ok(()) => {
                    take.event_count = take.event_count.saturating_add(1);
                    take.observe_preview(transport_tick, message);
                }
                Err(_) => take.dropped_events = take.dropped_events.saturating_add(1),
            }
        }
    }

    #[must_use]
    pub fn preview(&self) -> MidiRecordingPreview {
        let position_tick = self.position_ticks.load(Ordering::Relaxed);
        MidiRecordingPreview {
            position_tick,
            takes: self
                .takes
                .iter()
                .map(|take| MidiRecordingTakePreview {
                    clip_id: take.clip_id.clone(),
                    track_id: take.track_id.clone(),
                    notes: take
                        .preview_notes
                        .iter()
                        .map(|note| MidiRecordingPreviewNote {
                            id: note.id,
                            start_tick: note.start_tick,
                            end_tick: note
                                .end_tick
                                .unwrap_or(position_tick)
                                .max(note.start_tick.saturating_add(1)),
                            channel: note.channel,
                            key: note.key,
                            velocity: note.velocity,
                            active: note.end_tick.is_none(),
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    pub fn stop(mut self) -> Result<Vec<MidiRecordingTakeResult>, String> {
        let mut results = Vec::with_capacity(self.takes.len());
        for mut take in self.takes.drain(..) {
            take.writer
                .flush()
                .map_err(|error| format!("failed to flush MIDI journal: {error}"))?;
            results.push(MidiRecordingTakeResult {
                path: take.path,
                source_id: take.source_id,
                clip_id: take.clip_id,
                track_id: take.track_id,
                event_count: take.event_count,
                dropped_events: take.dropped_events,
            });
        }
        Ok(results)
    }
}

impl ActiveMidiTake {
    fn observe_preview(&mut self, tick: u64, message: &MidiInputMessage) {
        match *message {
            MidiInputMessage::NoteOn(channel, key, velocity) if velocity > 0 => {
                let index = self.preview_notes.len();
                self.preview_notes.push(PreviewNote {
                    id: self.next_preview_note_id,
                    start_tick: tick,
                    end_tick: None,
                    channel,
                    key,
                    velocity,
                });
                self.next_preview_note_id = self.next_preview_note_id.saturating_add(1);
                self.open_preview_notes
                    .entry((channel, key))
                    .or_default()
                    .push_back(index);
            }
            MidiInputMessage::NoteOn(channel, key, _)
            | MidiInputMessage::NoteOff(channel, key, _) => {
                let Some(index) = self
                    .open_preview_notes
                    .get_mut(&(channel, key))
                    .and_then(VecDeque::pop_front)
                else {
                    return;
                };
                if let Some(note) = self.preview_notes.get_mut(index) {
                    note.end_tick = Some(tick.max(note.start_tick.saturating_add(1)));
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use yadaw_dsp_runtime::{
        midi_journal::recover_midi_journal, protocol::MidiRecordingTakeConfig,
    };

    fn temporary_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time moves forward")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "yadaw-midi-rec-{label}-{}-{nonce}.midijournal",
            std::process::id()
        ))
    }

    fn clock(state: u32, frames: u64, ticks: u64) -> TransportClockHandle {
        TransportClockHandle {
            state: Arc::new(AtomicU32::new(state)),
            position_frames: Arc::new(AtomicU64::new(frames)),
            position_ticks: Arc::new(AtomicU64::new(ticks)),
            recording_state: 2,
        }
    }

    #[test]
    fn records_matching_route_only_while_transport_is_recording() {
        let path = temporary_path("route-filter");
        let handle = clock(2, 480, 960);
        let mut session = MidiRecordingSession::start(
            MidiRecordingStartConfig {
                takes: vec![MidiRecordingTakeConfig {
                    path: path.to_string_lossy().into_owned(),
                    source_id: "source".to_owned(),
                    clip_id: "clip".to_owned(),
                    track_id: "track".to_owned(),
                    port_id: Some("port-a".to_owned()),
                    channel: Some(1),
                }],
            },
            handle.clone(),
        )
        .unwrap();
        let port_a = stable_port_key("port-a");
        let port_b = stable_port_key("port-b");

        // Wrong port / channel ignored.
        session.observe(1, port_b, &MidiInputMessage::NoteOn(1, 60, 100));
        session.observe(2, port_a, &MidiInputMessage::NoteOn(0, 60, 100));
        // Count-in ignored.
        handle.state.store(4, Ordering::Relaxed);
        session.observe(3, port_a, &MidiInputMessage::NoteOn(1, 61, 100));
        // Recording accepted.
        handle.state.store(2, Ordering::Relaxed);
        handle.position_ticks.store(1_920, Ordering::Relaxed);
        session.observe(4, port_a, &MidiInputMessage::NoteOn(1, 62, 100));
        session.observe(5, port_a, &MidiInputMessage::NoteOff(1, 62, 40));

        let results = session.stop().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].event_count, 2);
        assert_eq!(results[0].dropped_events, 0);

        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records.len(), 2);
        assert_eq!(recovered.records[0].transport_tick, Some(1_920));
        assert_eq!(recovered.records[0].bytes, vec![0x91, 62, 100]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn start_rejects_empty_takes_and_invalid_fields() {
        let handle = clock(2, 0, 0);
        let empty = MidiRecordingSession::start(
            MidiRecordingStartConfig { takes: Vec::new() },
            handle.clone(),
        );
        match empty {
            Err(message) => assert!(message.contains("at least one take")),
            Ok(_) => panic!("expected empty takes to fail"),
        }

        let invalid_channel = MidiRecordingSession::start(
            MidiRecordingStartConfig {
                takes: vec![MidiRecordingTakeConfig {
                    path: temporary_path("invalid-channel")
                        .to_string_lossy()
                        .into_owned(),
                    source_id: "source".to_owned(),
                    clip_id: "clip".to_owned(),
                    track_id: "track".to_owned(),
                    port_id: None,
                    channel: Some(16),
                }],
            },
            handle.clone(),
        );
        match invalid_channel {
            Err(message) => assert!(message.contains("0 and 15")),
            Ok(_) => panic!("expected invalid channel to fail"),
        }

        let empty_id = MidiRecordingSession::start(
            MidiRecordingStartConfig {
                takes: vec![MidiRecordingTakeConfig {
                    path: temporary_path("empty-id").to_string_lossy().into_owned(),
                    source_id: String::new(),
                    clip_id: "clip".to_owned(),
                    track_id: "track".to_owned(),
                    port_id: None,
                    channel: None,
                }],
            },
            handle,
        );
        match empty_id {
            Err(message) => assert!(message.contains("non-empty")),
            Ok(_) => panic!("expected empty source id to fail"),
        }
    }

    #[test]
    fn accept_all_route_records_any_port_and_ignores_non_recordable() {
        let path = temporary_path("accept-all");
        let handle = clock(2, 0, 0);
        let mut session = MidiRecordingSession::start(
            MidiRecordingStartConfig {
                takes: vec![MidiRecordingTakeConfig {
                    path: path.to_string_lossy().into_owned(),
                    source_id: "source".to_owned(),
                    clip_id: "clip".to_owned(),
                    track_id: "track".to_owned(),
                    port_id: None,
                    channel: None,
                }],
            },
            handle,
        )
        .unwrap();
        session.observe(1, 99, &MidiInputMessage::Clock);
        session.observe(2, 99, &MidiInputMessage::NoteOn(9, 40, 80));
        let results = session.stop().unwrap();
        assert_eq!(results[0].event_count, 1);
        let recovered = recover_midi_journal(&path).unwrap();
        assert_eq!(recovered.records.len(), 1);
        assert_eq!(recovered.records[0].bytes, vec![0x99, 40, 80]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn multi_take_session_fans_out_by_port() {
        let path_a = temporary_path("multi-a");
        let path_b = temporary_path("multi-b");
        let handle = clock(2, 10, 20);
        let mut session = MidiRecordingSession::start(
            MidiRecordingStartConfig {
                takes: vec![
                    MidiRecordingTakeConfig {
                        path: path_a.to_string_lossy().into_owned(),
                        source_id: "source-a".to_owned(),
                        clip_id: "clip-a".to_owned(),
                        track_id: "track-a".to_owned(),
                        port_id: Some("port-a".to_owned()),
                        channel: None,
                    },
                    MidiRecordingTakeConfig {
                        path: path_b.to_string_lossy().into_owned(),
                        source_id: "source-b".to_owned(),
                        clip_id: "clip-b".to_owned(),
                        track_id: "track-b".to_owned(),
                        port_id: Some("port-b".to_owned()),
                        channel: None,
                    },
                ],
            },
            handle,
        )
        .unwrap();
        let port_a = stable_port_key("port-a");
        let port_b = stable_port_key("port-b");
        session.observe(1, port_a, &MidiInputMessage::ControlChange(0, 1, 2));
        session.observe(2, port_b, &MidiInputMessage::ControlChange(0, 3, 4));
        let results = session.stop().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].event_count, 1);
        assert_eq!(results[1].event_count, 1);
        assert_eq!(recover_midi_journal(&path_a).unwrap().records.len(), 1);
        assert_eq!(recover_midi_journal(&path_b).unwrap().records.len(), 1);
        let _ = std::fs::remove_file(path_a);
        let _ = std::fs::remove_file(path_b);
    }

    #[test]
    fn preview_pairs_notes_and_extends_active_notes_to_the_transport_position() {
        let path = temporary_path("preview-notes");
        let handle = clock(2, 0, 960);
        let mut session = MidiRecordingSession::start(
            MidiRecordingStartConfig {
                takes: vec![MidiRecordingTakeConfig {
                    path: path.to_string_lossy().into_owned(),
                    source_id: "source".to_owned(),
                    clip_id: "clip".to_owned(),
                    track_id: "track".to_owned(),
                    port_id: None,
                    channel: None,
                }],
            },
            handle.clone(),
        )
        .unwrap();

        session.observe(1, 1, &MidiInputMessage::NoteOn(0, 60, 100));
        handle.position_ticks.store(1_200, Ordering::Relaxed);
        let active = session.preview();
        assert_eq!(active.position_tick, 1_200);
        assert_eq!(active.takes[0].notes[0].start_tick, 960);
        assert_eq!(active.takes[0].notes[0].end_tick, 1_200);
        assert!(active.takes[0].notes[0].active);

        session.observe(2, 1, &MidiInputMessage::NoteOff(0, 60, 48));
        handle.position_ticks.store(1_440, Ordering::Relaxed);
        let released = session.preview();
        assert_eq!(released.takes[0].notes[0].end_tick, 1_200);
        assert!(!released.takes[0].notes[0].active);

        let _ = session.stop();
        let _ = std::fs::remove_file(path);
    }
}
