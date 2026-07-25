use std::{error::Error, fmt};

use crate::MUSICAL_TICKS_PER_QUARTER;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TempoEvent {
    pub tick: u64,
    pub beats_per_minute: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeSignatureEvent {
    pub tick: u64,
    pub numerator: u8,
    pub denominator: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TempoMap {
    tempo_events: Vec<TempoEvent>,
    time_signature_events: Vec<TimeSignatureEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TempoMapError {
    MissingOrigin,
    UnorderedEvents,
    InvalidTempo,
    InvalidTimeSignature,
    InvalidSampleRate,
}

impl fmt::Display for TempoMapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingOrigin => "tempo and time-signature maps require an event at tick 0",
            Self::UnorderedEvents => "tempo-map event ticks must be strictly increasing",
            Self::InvalidTempo => "tempo must be finite and positive",
            Self::InvalidTimeSignature => "time signature is outside the supported range",
            Self::InvalidSampleRate => "sample rate must be positive",
        })
    }
}

impl Error for TempoMapError {}

impl TempoMap {
    pub fn new(
        tempo_events: Vec<TempoEvent>,
        time_signature_events: Vec<TimeSignatureEvent>,
    ) -> Result<Self, TempoMapError> {
        if tempo_events.first().is_none_or(|event| event.tick != 0)
            || time_signature_events
                .first()
                .is_none_or(|event| event.tick != 0)
        {
            return Err(TempoMapError::MissingOrigin);
        }
        if tempo_events
            .windows(2)
            .any(|events| events[0].tick >= events[1].tick)
            || time_signature_events
                .windows(2)
                .any(|events| events[0].tick >= events[1].tick)
        {
            return Err(TempoMapError::UnorderedEvents);
        }
        if tempo_events
            .iter()
            .any(|event| !event.beats_per_minute.is_finite() || event.beats_per_minute <= 0.0)
        {
            return Err(TempoMapError::InvalidTempo);
        }
        if time_signature_events.iter().any(|event| {
            !(1..=32).contains(&event.numerator)
                || !matches!(event.denominator, 1 | 2 | 4 | 8 | 16 | 32)
        }) {
            return Err(TempoMapError::InvalidTimeSignature);
        }
        Ok(Self {
            tempo_events,
            time_signature_events,
        })
    }

    pub fn default_120_bpm() -> Self {
        Self {
            tempo_events: vec![TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        }
    }

    pub fn tempo_events(&self) -> &[TempoEvent] {
        &self.tempo_events
    }

    pub fn time_signature_events(&self) -> &[TimeSignatureEvent] {
        &self.time_signature_events
    }

    pub fn tick_to_frame(&self, tick: u64, sample_rate: u32) -> Result<u64, TempoMapError> {
        if sample_rate == 0 {
            return Err(TempoMapError::InvalidSampleRate);
        }
        let mut frames = 0.0;
        let mut previous_tick = 0;
        let mut tempo = self.tempo_events[0].beats_per_minute;
        for event in self.tempo_events.iter().skip(1) {
            if event.tick >= tick {
                break;
            }
            frames += ticks_to_frames(event.tick - previous_tick, tempo, sample_rate);
            previous_tick = event.tick;
            tempo = event.beats_per_minute;
        }
        frames += ticks_to_frames(tick - previous_tick, tempo, sample_rate);
        Ok(frames.round() as u64)
    }

    pub fn tick_to_seconds(&self, tick: u64) -> f64 {
        let mut seconds = 0.0;
        let mut previous_tick = 0;
        let mut tempo = self.tempo_events[0].beats_per_minute;
        for event in self.tempo_events.iter().skip(1) {
            if event.tick >= tick {
                break;
            }
            seconds += ticks_to_seconds(event.tick - previous_tick, tempo);
            previous_tick = event.tick;
            tempo = event.beats_per_minute;
        }
        seconds + ticks_to_seconds(tick - previous_tick, tempo)
    }

    pub fn seconds_to_tick(&self, seconds: f64) -> u64 {
        let mut remaining = seconds.max(0.0);
        let mut previous_tick = 0;
        let mut tempo = self.tempo_events[0].beats_per_minute;
        for event in self.tempo_events.iter().skip(1) {
            let segment = ticks_to_seconds(event.tick - previous_tick, tempo);
            if remaining <= segment {
                return previous_tick + seconds_to_ticks(remaining, tempo).round() as u64;
            }
            remaining -= segment;
            previous_tick = event.tick;
            tempo = event.beats_per_minute;
        }
        previous_tick + seconds_to_ticks(remaining, tempo).round() as u64
    }

    pub fn frame_to_tick(&self, frame: u64, sample_rate: u32) -> Result<u64, TempoMapError> {
        if sample_rate == 0 {
            return Err(TempoMapError::InvalidSampleRate);
        }
        let mut remaining = frame as f64;
        let mut previous_tick = 0;
        let mut tempo = self.tempo_events[0].beats_per_minute;
        for event in self.tempo_events.iter().skip(1) {
            let segment = ticks_to_frames(event.tick - previous_tick, tempo, sample_rate);
            if remaining <= segment {
                return Ok(
                    previous_tick + frames_to_ticks(remaining, tempo, sample_rate).round() as u64
                );
            }
            remaining -= segment;
            previous_tick = event.tick;
            tempo = event.beats_per_minute;
        }
        Ok(previous_tick + frames_to_ticks(remaining, tempo, sample_rate).round() as u64)
    }

    pub fn split_block_at_tempo_events(
        &self,
        start_frame: u64,
        frame_count: usize,
        sample_rate: u32,
        maximum_block: usize,
    ) -> Result<Vec<usize>, TempoMapError> {
        if sample_rate == 0 {
            return Err(TempoMapError::InvalidSampleRate);
        }
        let maximum_block = maximum_block.max(1);
        let end_frame = start_frame.saturating_add(frame_count as u64);
        let mut boundaries = self
            .tempo_events
            .iter()
            .skip(1)
            .filter_map(|event| self.tick_to_frame(event.tick, sample_rate).ok())
            .filter(|frame| *frame > start_frame && *frame < end_frame)
            .collect::<Vec<_>>();
        boundaries.push(end_frame);
        let mut result = Vec::new();
        let mut cursor = start_frame;
        for boundary in boundaries {
            while cursor < boundary {
                let length = (boundary - cursor).min(maximum_block as u64) as usize;
                result.push(length);
                cursor += length as u64;
            }
        }
        Ok(result)
    }
}

fn ticks_to_frames(ticks: u64, tempo: f64, sample_rate: u32) -> f64 {
    ticks_to_seconds(ticks, tempo) * sample_rate as f64
}

fn frames_to_ticks(frames: f64, tempo: f64, sample_rate: u32) -> f64 {
    frames / sample_rate as f64 * tempo / 60.0 * MUSICAL_TICKS_PER_QUARTER as f64
}

fn ticks_to_seconds(ticks: u64, tempo: f64) -> f64 {
    ticks as f64 / MUSICAL_TICKS_PER_QUARTER as f64 * 60.0 / tempo
}

fn seconds_to_ticks(seconds: f64, tempo: f64) -> f64 {
    seconds * tempo / 60.0 * MUSICAL_TICKS_PER_QUARTER as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stepped_map() -> TempoMap {
        TempoMap::new(
            vec![
                TempoEvent {
                    tick: 0,
                    beats_per_minute: 120.0,
                },
                TempoEvent {
                    tick: 3_840,
                    beats_per_minute: 60.0,
                },
            ],
            vec![TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        )
        .unwrap()
    }

    #[test]
    fn converts_ticks_across_step_tempo_changes() {
        let map = stepped_map();
        assert_eq!(map.tick_to_frame(3_840, 48_000), Ok(96_000));
        assert_eq!(map.tick_to_frame(4_800, 48_000), Ok(144_000));
        assert_eq!(map.frame_to_tick(144_000, 48_000), Ok(4_800));
    }

    #[test]
    fn splits_at_markers_and_maximum_plugin_block() {
        let map = stepped_map();
        let blocks = map
            .split_block_at_tempo_events(95_000, 5_500, 48_000, 2_048)
            .unwrap();
        assert_eq!(blocks, vec![1_000, 2_048, 2_048, 404]);
    }

    #[test]
    fn rejects_maps_without_tick_zero() {
        assert_eq!(
            TempoMap::new(
                vec![TempoEvent {
                    tick: 1,
                    beats_per_minute: 120.0,
                }],
                vec![TimeSignatureEvent {
                    tick: 0,
                    numerator: 4,
                    denominator: 4,
                }],
            ),
            Err(TempoMapError::MissingOrigin)
        );
    }
}
