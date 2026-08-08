use std::fs;

use heron_dsp_runtime::{
    midi::{MidiFileFormat, NormalizedMidiEventKind, NormalizedSmf, normalize_smf},
    tempo::{TempoEvent, TempoMap, TimeSignatureEvent},
};
use napi::{
    Error, Result, Status, Task,
    bindgen_prelude::{AsyncTask, Buffer},
};
use napi_derive::napi;

#[napi(object)]
pub struct NativeTempoEvent {
    pub tick: i64,
    pub beats_per_minute: f64,
}

#[napi(object)]
pub struct NativeTimeSignatureEvent {
    pub tick: i64,
    pub numerator: u32,
    pub denominator: u32,
}

#[napi(object)]
pub struct NativeTempoMap {
    pub tempo_events: Vec<NativeTempoEvent>,
    pub time_signature_events: Vec<NativeTimeSignatureEvent>,
}

#[napi(object)]
pub struct NativeMidiNote {
    pub start_tick: i64,
    pub duration_ticks: i64,
    pub channel: u32,
    pub key: u32,
    pub velocity: u32,
    pub release_velocity: u32,
}

#[napi(object)]
pub struct NativeMidiEvent {
    pub tick: i64,
    pub channel: Option<u32>,
    pub kind: String,
    pub data: Buffer,
}

#[napi(object)]
pub struct NativeMidiTrack {
    pub source_track: u32,
    pub sequence: u32,
    pub name: String,
    pub length_ticks: i64,
    pub notes: Vec<NativeMidiNote>,
    pub events: Vec<NativeMidiEvent>,
    pub tempo_events: Vec<NativeTempoEvent>,
    pub time_signature_events: Vec<NativeTimeSignatureEvent>,
    pub warnings: Vec<String>,
}

#[napi(object)]
pub struct NativeNormalizedSmf {
    pub format: u32,
    pub source_timing: String,
    pub tracks: Vec<NativeMidiTrack>,
    pub tempo_events: Vec<NativeTempoEvent>,
    pub time_signature_events: Vec<NativeTimeSignatureEvent>,
    pub warnings: Vec<String>,
}

fn convert_tick(value: u64) -> Result<i64> {
    i64::try_from(value)
        .map_err(|_| Error::new(Status::InvalidArg, "MIDI tick exceeds the supported range"))
}

fn tempo_map(value: &NativeTempoMap) -> Result<TempoMap> {
    TempoMap::new(
        value
            .tempo_events
            .iter()
            .map(|event| {
                Ok(TempoEvent {
                    tick: u64::try_from(event.tick).map_err(|_| {
                        Error::new(Status::InvalidArg, "Tempo tick must be non-negative")
                    })?,
                    beats_per_minute: event.beats_per_minute,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        value
            .time_signature_events
            .iter()
            .map(|event| {
                Ok(TimeSignatureEvent {
                    tick: u64::try_from(event.tick).map_err(|_| {
                        Error::new(
                            Status::InvalidArg,
                            "Time-signature tick must be non-negative",
                        )
                    })?,
                    numerator: u8::try_from(event.numerator).map_err(|_| {
                        Error::new(Status::InvalidArg, "Time-signature numerator is invalid")
                    })?,
                    denominator: u8::try_from(event.denominator).map_err(|_| {
                        Error::new(Status::InvalidArg, "Time-signature denominator is invalid")
                    })?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
    )
    .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))
}

fn native_tempo_event(event: TempoEvent) -> Result<NativeTempoEvent> {
    Ok(NativeTempoEvent {
        tick: convert_tick(event.tick)?,
        beats_per_minute: event.beats_per_minute,
    })
}

fn native_signature(event: TimeSignatureEvent) -> Result<NativeTimeSignatureEvent> {
    Ok(NativeTimeSignatureEvent {
        tick: convert_tick(event.tick)?,
        numerator: u32::from(event.numerator),
        denominator: u32::from(event.denominator),
    })
}

fn into_native(value: NormalizedSmf) -> Result<NativeNormalizedSmf> {
    Ok(NativeNormalizedSmf {
        format: match value.format {
            MidiFileFormat::Format0 => 0,
            MidiFileFormat::Format1 => 1,
            MidiFileFormat::Format2 => 2,
        },
        source_timing: value.source_timing,
        tracks: value
            .tracks
            .into_iter()
            .map(|track| {
                Ok(NativeMidiTrack {
                    source_track: track.source_track as u32,
                    sequence: track.sequence as u32,
                    name: track.name,
                    length_ticks: convert_tick(track.length_ticks)?,
                    notes: track
                        .notes
                        .into_iter()
                        .map(|note| {
                            Ok(NativeMidiNote {
                                start_tick: convert_tick(note.start_tick)?,
                                duration_ticks: convert_tick(note.duration_ticks)?,
                                channel: u32::from(note.channel),
                                key: u32::from(note.key),
                                velocity: u32::from(note.velocity),
                                release_velocity: u32::from(note.release_velocity),
                            })
                        })
                        .collect::<Result<Vec<_>>>()?,
                    events: track
                        .events
                        .into_iter()
                        .map(|event| {
                            Ok(NativeMidiEvent {
                                tick: convert_tick(event.tick)?,
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
                                data: event.data.into(),
                            })
                        })
                        .collect::<Result<Vec<_>>>()?,
                    tempo_events: track
                        .tempo_events
                        .into_iter()
                        .map(native_tempo_event)
                        .collect::<Result<Vec<_>>>()?,
                    time_signature_events: track
                        .time_signature_events
                        .into_iter()
                        .map(native_signature)
                        .collect::<Result<Vec<_>>>()?,
                    warnings: track.warnings,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        tempo_events: value
            .tempo_events
            .into_iter()
            .map(native_tempo_event)
            .collect::<Result<Vec<_>>>()?,
        time_signature_events: value
            .time_signature_events
            .into_iter()
            .map(native_signature)
            .collect::<Result<Vec<_>>>()?,
        warnings: value.warnings,
    })
}

pub struct ParseMidiTask {
    source: ParseMidiSource,
    project_tempo_map: NativeTempoMap,
}

enum ParseMidiSource {
    File(String),
    Bytes(Vec<u8>),
}

#[napi]
impl Task for ParseMidiTask {
    type Output = NativeNormalizedSmf;
    type JsValue = NativeNormalizedSmf;

    fn compute(&mut self) -> Result<Self::Output> {
        let bytes = match &self.source {
            ParseMidiSource::File(path) => fs::read(path)
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?,
            ParseMidiSource::Bytes(bytes) => bytes.clone(),
        };
        let map = tempo_map(&self.project_tempo_map)?;
        into_native(
            normalize_smf(&bytes, &map)
                .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?,
        )
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn parse_midi_file(
    path: String,
    project_tempo_map: NativeTempoMap,
) -> AsyncTask<ParseMidiTask> {
    AsyncTask::new(ParseMidiTask {
        source: ParseMidiSource::File(path),
        project_tempo_map,
    })
}

#[napi]
pub fn parse_midi_data(
    bytes: Buffer,
    project_tempo_map: NativeTempoMap,
) -> AsyncTask<ParseMidiTask> {
    AsyncTask::new(ParseMidiTask {
        source: ParseMidiSource::Bytes(bytes.to_vec()),
        project_tempo_map,
    })
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;
    use heron_dsp_runtime::midi::{NormalizedMidiEvent, NormalizedMidiNote, NormalizedMidiTrack};

    fn representative_smf(format: MidiFileFormat) -> NormalizedSmf {
        NormalizedSmf {
            format,
            source_timing: "metrical:480".to_owned(),
            tracks: vec![NormalizedMidiTrack {
                source_track: 1,
                sequence: 2,
                name: "Keys".to_owned(),
                length_ticks: 960,
                notes: vec![NormalizedMidiNote {
                    start_tick: 10,
                    duration_ticks: 20,
                    channel: 1,
                    key: 60,
                    velocity: 100,
                    release_velocity: 64,
                }],
                events: [
                    NormalizedMidiEventKind::ControlChange,
                    NormalizedMidiEventKind::PitchBend,
                    NormalizedMidiEventKind::ProgramChange,
                    NormalizedMidiEventKind::ChannelPressure,
                    NormalizedMidiEventKind::PolyPressure,
                    NormalizedMidiEventKind::SysEx,
                ]
                .into_iter()
                .enumerate()
                .map(|(tick, kind)| NormalizedMidiEvent {
                    tick: tick as u64,
                    channel: (!matches!(kind, NormalizedMidiEventKind::SysEx)).then_some(1),
                    kind,
                    data: vec![tick as u8],
                })
                .collect(),
                tempo_events: vec![TempoEvent {
                    tick: 0,
                    beats_per_minute: 120.0,
                }],
                time_signature_events: vec![TimeSignatureEvent {
                    tick: 0,
                    numerator: 4,
                    denominator: 4,
                }],
                warnings: vec!["track warning".to_owned()],
            }],
            tempo_events: vec![TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
            warnings: vec!["file warning".to_owned()],
        }
    }

    #[test]
    fn tempo_map_validates_native_ranges() {
        let valid = NativeTempoMap {
            tempo_events: vec![NativeTempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![NativeTimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        };
        assert!(tempo_map(&valid).is_ok());

        for invalid in [
            NativeTempoMap {
                tempo_events: vec![NativeTempoEvent {
                    tick: -1,
                    beats_per_minute: 120.0,
                }],
                time_signature_events: Vec::new(),
            },
            NativeTempoMap {
                tempo_events: Vec::new(),
                time_signature_events: vec![NativeTimeSignatureEvent {
                    tick: -1,
                    numerator: 4,
                    denominator: 4,
                }],
            },
            NativeTempoMap {
                tempo_events: Vec::new(),
                time_signature_events: vec![NativeTimeSignatureEvent {
                    tick: 0,
                    numerator: 256,
                    denominator: 4,
                }],
            },
            NativeTempoMap {
                tempo_events: Vec::new(),
                time_signature_events: vec![NativeTimeSignatureEvent {
                    tick: 0,
                    numerator: 4,
                    denominator: 256,
                }],
            },
        ] {
            assert!(tempo_map(&invalid).is_err());
        }
    }

    #[test]
    fn normalized_smf_maps_all_formats_and_event_kinds() {
        for (format, expected) in [
            (MidiFileFormat::Format0, 0),
            (MidiFileFormat::Format1, 1),
            (MidiFileFormat::Format2, 2),
        ] {
            let native = into_native(representative_smf(format)).expect("SMF should convert");
            assert_eq!(native.format, expected);
            assert_eq!(native.tracks[0].notes[0].key, 60);
            assert_eq!(native.tracks[0].events.len(), 6);
            assert_eq!(native.tracks[0].events[5].kind, "sysex");
            assert_eq!(native.tempo_events[0].tick, 0);
            assert_eq!(native.time_signature_events[0].denominator, 4);
        }
    }

    #[test]
    fn tick_conversion_rejects_values_above_i64() {
        assert!(convert_tick(i64::MAX as u64).is_ok());
        assert!(convert_tick(i64::MAX as u64 + 1).is_err());
    }

    #[test]
    fn parse_midi_task_accepts_project_bytes_and_file_sources() {
        let bytes = vec![
            b'M', b'T', b'h', b'd', 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0, b'M', b'T', b'r', b'k', 0, 0,
            0, 4, 0, 0xff, 0x2f, 0,
        ];
        let map = || NativeTempoMap {
            tempo_events: vec![NativeTempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![NativeTimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        };
        let mut byte_task = ParseMidiTask {
            source: ParseMidiSource::Bytes(bytes.clone()),
            project_tempo_map: map(),
        };
        assert_eq!(byte_task.compute().expect("parse bytes").format, 0);

        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("time moves forward")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "heron-midi-import-{}-{nonce}.mid",
            std::process::id()
        ));
        fs::write(&path, bytes).expect("write MIDI fixture");
        let mut file_task = ParseMidiTask {
            source: ParseMidiSource::File(path.to_string_lossy().into_owned()),
            project_tempo_map: map(),
        };
        assert_eq!(file_task.compute().expect("parse file").format, 0);
        fs::remove_file(path).expect("remove MIDI fixture");
    }
}
