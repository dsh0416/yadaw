use std::{
    collections::{BTreeMap, VecDeque},
    error::Error,
    fmt,
};

use crate::{
    MUSICAL_TICKS_PER_QUARTER,
    tempo::{TempoEvent, TempoMap, TimeSignatureEvent},
};

#[derive(Debug)]
pub enum MidiImportError {
    InvalidFile(midly::Error),
}

impl fmt::Display for MidiImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFile(error) => write!(formatter, "invalid Standard MIDI File: {error}"),
        }
    }
}

impl Error for MidiImportError {}

impl From<midly::Error> for MidiImportError {
    fn from(value: midly::Error) -> Self {
        Self::InvalidFile(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidiFileFormat {
    Format0,
    Format1,
    Format2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MidiTrackPreview {
    pub source_track: usize,
    pub name: String,
    pub event_count: usize,
    pub length_source_ticks: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MidiFilePreview {
    pub format: MidiFileFormat,
    pub timing: String,
    pub tracks: Vec<MidiTrackPreview>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedMidiNote {
    pub start_tick: u64,
    pub duration_ticks: u64,
    pub channel: u8,
    pub key: u8,
    pub velocity: u8,
    pub release_velocity: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NormalizedMidiEventKind {
    ControlChange,
    PitchBend,
    ProgramChange,
    ChannelPressure,
    PolyPressure,
    SysEx,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedMidiEvent {
    pub tick: u64,
    pub channel: Option<u8>,
    pub kind: NormalizedMidiEventKind,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedMidiTrack {
    pub source_track: usize,
    pub sequence: usize,
    pub name: String,
    pub length_ticks: u64,
    pub notes: Vec<NormalizedMidiNote>,
    pub events: Vec<NormalizedMidiEvent>,
    pub tempo_events: Vec<TempoEvent>,
    pub time_signature_events: Vec<TimeSignatureEvent>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedSmf {
    pub format: MidiFileFormat,
    pub source_timing: String,
    pub tracks: Vec<NormalizedMidiTrack>,
    pub tempo_events: Vec<TempoEvent>,
    pub time_signature_events: Vec<TimeSignatureEvent>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChasedMidiMessage {
    NoteOn { channel: u8, key: u8, velocity: u8 },
    NoteOff { channel: u8, key: u8, velocity: u8 },
    Event(NormalizedMidiEvent),
}

pub fn chase_track(track: &NormalizedMidiTrack, tick: u64) -> Vec<ChasedMidiMessage> {
    let mut state = BTreeMap::<(u8, u8, u8), NormalizedMidiEvent>::new();
    for event in track.events.iter().filter(|event| event.tick <= tick) {
        let Some(channel) = event.channel else {
            continue;
        };
        let key = match event.kind {
            NormalizedMidiEventKind::ControlChange => {
                (0, channel, event.data.first().copied().unwrap_or(0))
            }
            NormalizedMidiEventKind::PitchBend => (1, channel, 0),
            NormalizedMidiEventKind::ProgramChange => (2, channel, 0),
            NormalizedMidiEventKind::ChannelPressure => (3, channel, 0),
            NormalizedMidiEventKind::PolyPressure => {
                (4, channel, event.data.first().copied().unwrap_or(0))
            }
            NormalizedMidiEventKind::SysEx => continue,
        };
        state.insert(key, event.clone());
    }
    let mut messages = state
        .into_values()
        .map(ChasedMidiMessage::Event)
        .collect::<Vec<_>>();
    messages.extend(
        track
            .notes
            .iter()
            .filter(|note| {
                note.start_tick <= tick
                    && note.start_tick.saturating_add(note.duration_ticks) > tick
            })
            .map(|note| ChasedMidiMessage::NoteOn {
                channel: note.channel,
                key: note.key,
                velocity: note.velocity,
            }),
    );
    messages
}

pub fn stop_chased_messages(messages: &[ChasedMidiMessage]) -> Vec<ChasedMidiMessage> {
    let mut channels = BTreeMap::<u8, ()>::new();
    let mut result = Vec::new();
    for message in messages {
        match message {
            ChasedMidiMessage::NoteOn { channel, key, .. } => {
                channels.insert(*channel, ());
                result.push(ChasedMidiMessage::NoteOff {
                    channel: *channel,
                    key: *key,
                    velocity: 0,
                });
            }
            ChasedMidiMessage::Event(event) => {
                if let Some(channel) = event.channel {
                    channels.insert(channel, ());
                }
            }
            ChasedMidiMessage::NoteOff { channel, .. } => {
                channels.insert(*channel, ());
            }
        }
    }
    for channel in channels.into_keys() {
        for (controller, value) in [(64, 0), (121, 0), (123, 0)] {
            result.push(ChasedMidiMessage::Event(NormalizedMidiEvent {
                tick: 0,
                channel: Some(channel),
                kind: NormalizedMidiEventKind::ControlChange,
                data: vec![controller, value],
            }));
        }
    }
    result
}

pub fn preview_smf(bytes: &[u8]) -> Result<MidiFilePreview, MidiImportError> {
    use midly::{Format, MetaMessage, Smf, Timing, TrackEventKind};

    let smf = Smf::parse(bytes)?;
    let format = match smf.header.format {
        Format::SingleTrack => MidiFileFormat::Format0,
        Format::Parallel => MidiFileFormat::Format1,
        Format::Sequential => MidiFileFormat::Format2,
    };
    let timing = match smf.header.timing {
        Timing::Metrical(ticks) => format!("{} PPQ", ticks.as_int()),
        Timing::Timecode(frames, subframes) => {
            format!("{} fps / {subframes} subframes", frames.as_f32())
        }
    };
    let tracks = smf
        .tracks
        .iter()
        .enumerate()
        .map(|(source_track, track)| {
            let mut absolute_tick = 0_u64;
            let mut name = String::new();
            for event in track {
                absolute_tick += u64::from(event.delta.as_int());
                if let TrackEventKind::Meta(MetaMessage::TrackName(value)) = event.kind {
                    name = String::from_utf8_lossy(value).into_owned();
                }
            }
            MidiTrackPreview {
                source_track,
                name,
                event_count: track.len(),
                length_source_ticks: absolute_tick,
            }
        })
        .collect();
    Ok(MidiFilePreview {
        format,
        timing,
        tracks,
    })
}

pub fn normalize_smf(
    bytes: &[u8],
    project_tempo_map: &TempoMap,
) -> Result<NormalizedSmf, MidiImportError> {
    use midly::{Format, MetaMessage, MidiMessage, Smf, Timing, TrackEventKind};

    let smf = Smf::parse(bytes)?;
    let format = match smf.header.format {
        Format::SingleTrack => MidiFileFormat::Format0,
        Format::Parallel => MidiFileFormat::Format1,
        Format::Sequential => MidiFileFormat::Format2,
    };
    let source_timing = match smf.header.timing {
        Timing::Metrical(ticks) => format!("{} PPQ", ticks.as_int()),
        Timing::Timecode(frames, subframes) => {
            format!("{} fps / {subframes} subframes", frames.as_f32())
        }
    };
    let to_tick = |source_tick: u64| match smf.header.timing {
        Timing::Metrical(ppq) => {
            (source_tick * u64::from(MUSICAL_TICKS_PER_QUARTER) + u64::from(ppq.as_int()) / 2)
                / u64::from(ppq.as_int())
        }
        Timing::Timecode(fps, subframes) => {
            let seconds = source_tick as f64 / f64::from(fps.as_f32()) / f64::from(subframes);
            project_tempo_map.seconds_to_tick(seconds)
        }
    };

    let mut tempo_events = BTreeMap::new();
    let mut time_signature_events = BTreeMap::new();
    let mut tracks = Vec::with_capacity(smf.tracks.len());
    for (source_track, track) in smf.tracks.iter().enumerate() {
        let sequence = if format == MidiFileFormat::Format2 {
            source_track
        } else {
            0
        };
        let mut source_tick = 0_u64;
        let mut name = String::new();
        let mut notes = Vec::new();
        let mut events = Vec::new();
        let mut warnings = Vec::new();
        let mut track_tempo_events = BTreeMap::new();
        let mut track_time_signature_events = BTreeMap::new();
        let mut open_notes: BTreeMap<(u8, u8), VecDeque<(u64, u8)>> = BTreeMap::new();
        for event in track {
            source_tick += u64::from(event.delta.as_int());
            let tick = to_tick(source_tick);
            match event.kind {
                TrackEventKind::Midi { channel, message } => {
                    let channel = channel.as_int();
                    match message {
                        MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                            open_notes
                                .entry((channel, key.as_int()))
                                .or_default()
                                .push_back((tick, vel.as_int()));
                        }
                        MidiMessage::NoteOn { key, vel: _ }
                        | MidiMessage::NoteOff { key, vel: _ } => {
                            let release_velocity = match message {
                                MidiMessage::NoteOff { vel, .. } => vel.as_int(),
                                _ => 0,
                            };
                            close_note(
                                &mut open_notes,
                                &mut notes,
                                channel,
                                key.as_int(),
                                tick,
                                release_velocity,
                                &mut warnings,
                            );
                        }
                        MidiMessage::Controller { controller, value } => {
                            events.push(NormalizedMidiEvent {
                                tick,
                                channel: Some(channel),
                                kind: NormalizedMidiEventKind::ControlChange,
                                data: vec![controller.as_int(), value.as_int()],
                            });
                        }
                        MidiMessage::PitchBend { bend } => {
                            events.push(NormalizedMidiEvent {
                                tick,
                                channel: Some(channel),
                                kind: NormalizedMidiEventKind::PitchBend,
                                data: bend.as_int().to_le_bytes().to_vec(),
                            });
                        }
                        MidiMessage::ProgramChange { program } => {
                            events.push(NormalizedMidiEvent {
                                tick,
                                channel: Some(channel),
                                kind: NormalizedMidiEventKind::ProgramChange,
                                data: vec![program.as_int()],
                            });
                        }
                        MidiMessage::ChannelAftertouch { vel } => {
                            events.push(NormalizedMidiEvent {
                                tick,
                                channel: Some(channel),
                                kind: NormalizedMidiEventKind::ChannelPressure,
                                data: vec![vel.as_int()],
                            });
                        }
                        MidiMessage::Aftertouch { key, vel } => {
                            events.push(NormalizedMidiEvent {
                                tick,
                                channel: Some(channel),
                                kind: NormalizedMidiEventKind::PolyPressure,
                                data: vec![key.as_int(), vel.as_int()],
                            });
                        }
                    }
                }
                TrackEventKind::SysEx(data) | TrackEventKind::Escape(data) => {
                    events.push(NormalizedMidiEvent {
                        tick,
                        channel: None,
                        kind: NormalizedMidiEventKind::SysEx,
                        data: data.to_vec(),
                    });
                }
                TrackEventKind::Meta(message) => match message {
                    MetaMessage::TrackName(value) => {
                        name = String::from_utf8_lossy(value).into_owned();
                    }
                    MetaMessage::Tempo(microseconds) => {
                        let value = microseconds.as_int();
                        if value > 0 {
                            let beats_per_minute = 60_000_000.0 / f64::from(value);
                            track_tempo_events.insert(tick, beats_per_minute);
                            if format != MidiFileFormat::Format2 || source_track == 0 {
                                tempo_events.insert(tick, beats_per_minute);
                            }
                        }
                    }
                    MetaMessage::TimeSignature(numerator, denominator_power, _, _) => {
                        let denominator =
                            1_u16.checked_shl(u32::from(denominator_power)).unwrap_or(0);
                        if denominator <= 32 {
                            track_time_signature_events
                                .insert(tick, (numerator, denominator as u8));
                            if format != MidiFileFormat::Format2 || source_track == 0 {
                                time_signature_events.insert(tick, (numerator, denominator as u8));
                            }
                        } else {
                            warnings.push(format!(
                                "Ignored unsupported time signature {numerator}/{denominator}"
                            ));
                        }
                    }
                    _ => {}
                },
            }
        }
        let length_ticks = to_tick(source_tick).max(1);
        for ((channel, key), pending) in open_notes {
            for (start_tick, velocity) in pending {
                notes.push(NormalizedMidiNote {
                    start_tick,
                    duration_ticks: length_ticks.saturating_sub(start_tick).max(1),
                    channel,
                    key,
                    velocity,
                    release_velocity: 0,
                });
                warnings.push(format!(
                    "Closed unterminated note {key} on channel {} at track end",
                    channel + 1
                ));
            }
        }
        notes.sort_by_key(|note| (note.start_tick, note.channel, note.key));
        events.sort_by_key(|event| event.tick);
        tracks.push(NormalizedMidiTrack {
            source_track,
            sequence,
            name,
            length_ticks,
            notes,
            events,
            tempo_events: with_initial_tempo(track_tempo_events),
            time_signature_events: with_initial_signature(track_time_signature_events),
            warnings,
        });
    }
    let mut warnings = Vec::new();
    if format == MidiFileFormat::Format2 && smf.tracks.len() > 1 {
        warnings.push(
            "Format 2 sequences have independent tempo maps and must be imported separately"
                .to_owned(),
        );
    }
    let tempo_events = with_initial_tempo(tempo_events);
    let time_signature_events = with_initial_signature(time_signature_events);
    Ok(NormalizedSmf {
        format,
        source_timing,
        tracks,
        tempo_events,
        time_signature_events,
        warnings,
    })
}

fn close_note(
    open_notes: &mut BTreeMap<(u8, u8), VecDeque<(u64, u8)>>,
    notes: &mut Vec<NormalizedMidiNote>,
    channel: u8,
    key: u8,
    end_tick: u64,
    release_velocity: u8,
    warnings: &mut Vec<String>,
) {
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
        duration_ticks: end_tick.saturating_sub(start_tick).max(1),
        channel,
        key,
        velocity,
        release_velocity,
    });
}

fn with_initial_tempo(values: BTreeMap<u64, f64>) -> Vec<TempoEvent> {
    let mut values = values;
    values.entry(0).or_insert(120.0);
    values
        .into_iter()
        .map(|(tick, beats_per_minute)| TempoEvent {
            tick,
            beats_per_minute,
        })
        .collect()
}

fn with_initial_signature(values: BTreeMap<u64, (u8, u8)>) -> Vec<TimeSignatureEvent> {
    let mut values = values;
    values.entry(0).or_insert((4, 4));
    values
        .into_iter()
        .map(|(tick, (numerator, denominator))| TimeSignatureEvent {
            tick,
            numerator,
            denominator,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use midly::{
        Format, Fps, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind,
        num::{u4, u7, u15, u24, u28},
    };

    use super::*;

    #[test]
    fn previews_format_one_tracks_and_timing() {
        let smf = Smf {
            header: Header::new(Format::Parallel, Timing::Metrical(u15::new(480))),
            tracks: vec![vec![
                TrackEvent {
                    delta: u28::new(0),
                    kind: TrackEventKind::Meta(MetaMessage::TrackName(b"Keys")),
                },
                TrackEvent {
                    delta: u28::new(480),
                    kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(500_000))),
                },
            ]],
        };
        let mut bytes = Vec::new();
        smf.write_std(&mut bytes).unwrap();
        let preview = preview_smf(&bytes).unwrap();
        assert_eq!(preview.format, MidiFileFormat::Format1);
        assert_eq!(preview.timing, "480 PPQ");
        assert_eq!(preview.tracks[0].name, "Keys");
        assert_eq!(preview.tracks[0].length_source_ticks, 480);
    }

    #[test]
    fn normalizes_smpte_time_through_the_project_tempo_map() {
        let smf = Smf {
            header: Header::new(Format::SingleTrack, Timing::Timecode(Fps::Fps25, 40)),
            tracks: vec![vec![
                TrackEvent {
                    delta: u28::new(0),
                    kind: TrackEventKind::Midi {
                        channel: u4::new(0),
                        message: MidiMessage::NoteOn {
                            key: u7::new(60),
                            vel: u7::new(100),
                        },
                    },
                },
                TrackEvent {
                    delta: u28::new(1_000),
                    kind: TrackEventKind::Midi {
                        channel: u4::new(0),
                        message: MidiMessage::NoteOff {
                            key: u7::new(60),
                            vel: u7::new(40),
                        },
                    },
                },
            ]],
        };
        let mut bytes = Vec::new();
        smf.write_std(&mut bytes).unwrap();

        let normalized = normalize_smf(&bytes, &TempoMap::default_120_bpm()).unwrap();

        assert_eq!(normalized.source_timing, "25 fps / 40 subframes");
        assert_eq!(normalized.tracks[0].notes[0].duration_ticks, 1_920);
        assert_eq!(normalized.tracks[0].notes[0].release_velocity, 40);
    }

    #[test]
    fn preserves_independent_format_two_sequence_tempo_maps() {
        let smf = Smf {
            header: Header::new(Format::Sequential, Timing::Metrical(u15::new(960))),
            tracks: vec![
                vec![TrackEvent {
                    delta: u28::new(0),
                    kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(500_000))),
                }],
                vec![TrackEvent {
                    delta: u28::new(0),
                    kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(1_000_000))),
                }],
            ],
        };
        let mut bytes = Vec::new();
        smf.write_std(&mut bytes).unwrap();

        let normalized = normalize_smf(&bytes, &TempoMap::default_120_bpm()).unwrap();

        assert_eq!(normalized.tracks[0].tempo_events[0].beats_per_minute, 120.0);
        assert_eq!(normalized.tracks[1].tempo_events[0].beats_per_minute, 60.0);
        assert_eq!(normalized.tempo_events[0].beats_per_minute, 120.0);
    }

    #[test]
    fn chase_restores_controller_state_and_active_notes_then_resets_on_stop() {
        let track = NormalizedMidiTrack {
            source_track: 0,
            sequence: 0,
            name: "Keys".into(),
            length_ticks: 1_920,
            notes: vec![NormalizedMidiNote {
                start_tick: 0,
                duration_ticks: 1_920,
                channel: 2,
                key: 64,
                velocity: 96,
                release_velocity: 0,
            }],
            events: vec![
                NormalizedMidiEvent {
                    tick: 0,
                    channel: Some(2),
                    kind: NormalizedMidiEventKind::ControlChange,
                    data: vec![1, 10],
                },
                NormalizedMidiEvent {
                    tick: 480,
                    channel: Some(2),
                    kind: NormalizedMidiEventKind::ControlChange,
                    data: vec![1, 80],
                },
            ],
            tempo_events: vec![TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
            warnings: vec![],
        };

        let chased = chase_track(&track, 960);

        assert!(
            chased.contains(&ChasedMidiMessage::Event(NormalizedMidiEvent {
                tick: 480,
                channel: Some(2),
                kind: NormalizedMidiEventKind::ControlChange,
                data: vec![1, 80],
            }))
        );
        assert!(chased.contains(&ChasedMidiMessage::NoteOn {
            channel: 2,
            key: 64,
            velocity: 96,
        }));
        let stopped = stop_chased_messages(&chased);
        assert!(stopped.contains(&ChasedMidiMessage::NoteOff {
            channel: 2,
            key: 64,
            velocity: 0,
        }));
        assert!(stopped.iter().any(|message| matches!(
            message,
            ChasedMidiMessage::Event(NormalizedMidiEvent {
                kind: NormalizedMidiEventKind::ControlChange,
                data,
                ..
            }) if data.as_slice() == [123, 0]
        )));
    }
}
