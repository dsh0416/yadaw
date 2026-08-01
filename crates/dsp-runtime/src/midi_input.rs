use std::collections::BTreeMap;

pub const MIDI_CLOCKS_PER_QUARTER: u64 = 24;
pub const MUSICAL_TICKS_PER_MIDI_CLOCK: u64 =
    crate::MUSICAL_TICKS_PER_QUARTER as u64 / MIDI_CLOCKS_PER_QUARTER;
pub const MUSICAL_TICKS_PER_SONG_POSITION: u64 = crate::MUSICAL_TICKS_PER_QUARTER as u64 / 4;
pub const MIDI_SHORT_QUEUE_CAPACITY: usize = 16_384;
pub const MIDI_SYSEX_SLAB_BYTES: usize = 4 * 1024 * 1024;
pub const MIDI_MAX_SYSEX_BYTES: usize = 1024 * 1024;
pub const MIDI_CLOCK_FREEWHEEL_MICROS: u64 = 500_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MidiInputMessage {
    NoteOff(u8, u8, u8),
    NoteOn(u8, u8, u8),
    PolyPressure(u8, u8, u8),
    ControlChange(u8, u8, u8),
    ProgramChange(u8, u8),
    ChannelPressure(u8, u8),
    PitchBend(u8, u16),
    SysEx(Vec<u8>),
    Clock,
    Start,
    Continue,
    Stop,
    SongPosition(u16),
    ActiveSensing,
    SystemReset,
    IgnoredSystem(u8),
}

impl MidiInputMessage {
    #[must_use]
    pub fn channel(&self) -> Option<u8> {
        match self {
            Self::NoteOff(channel, ..)
            | Self::NoteOn(channel, ..)
            | Self::PolyPressure(channel, ..)
            | Self::ControlChange(channel, ..)
            | Self::ProgramChange(channel, ..)
            | Self::ChannelPressure(channel, ..)
            | Self::PitchBend(channel, ..) => Some(*channel),
            _ => None,
        }
    }

    #[must_use]
    pub fn is_recordable(&self) -> bool {
        matches!(
            self,
            Self::NoteOff(..)
                | Self::NoteOn(..)
                | Self::PolyPressure(..)
                | Self::ControlChange(..)
                | Self::ProgramChange(..)
                | Self::ChannelPressure(..)
                | Self::PitchBend(..)
                | Self::SysEx(_)
        )
    }

    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::NoteOff(channel, key, velocity) => {
                vec![0x80 | (channel & 0x0f), *key, *velocity]
            }
            Self::NoteOn(channel, key, velocity) => {
                vec![0x90 | (channel & 0x0f), *key, *velocity]
            }
            Self::PolyPressure(channel, key, pressure) => {
                vec![0xa0 | (channel & 0x0f), *key, *pressure]
            }
            Self::ControlChange(channel, controller, value) => {
                vec![0xb0 | (channel & 0x0f), *controller, *value]
            }
            Self::ProgramChange(channel, program) => {
                vec![0xc0 | (channel & 0x0f), *program]
            }
            Self::ChannelPressure(channel, pressure) => {
                vec![0xd0 | (channel & 0x0f), *pressure]
            }
            Self::PitchBend(channel, value) => {
                vec![
                    0xe0 | (channel & 0x0f),
                    (*value & 0x7f) as u8,
                    ((*value >> 7) & 0x7f) as u8,
                ]
            }
            Self::SysEx(bytes) => {
                let mut encoded = Vec::with_capacity(bytes.len().saturating_add(2));
                encoded.push(0xf0);
                encoded.extend_from_slice(bytes);
                encoded.push(0xf7);
                encoded
            }
            Self::Clock => vec![0xf8],
            Self::Start => vec![0xfa],
            Self::Continue => vec![0xfb],
            Self::Stop => vec![0xfc],
            Self::SongPosition(position) => vec![
                0xf2,
                (*position & 0x7f) as u8,
                ((*position >> 7) & 0x7f) as u8,
            ],
            Self::ActiveSensing => vec![0xfe],
            Self::SystemReset => vec![0xff],
            Self::IgnoredSystem(status) => vec![*status],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidiParseError {
    DataWithoutStatus,
    SysExTooLarge,
}

#[derive(Default)]
pub struct MidiInputParser {
    running_status: Option<u8>,
    pending_status: Option<u8>,
    pending_data: [u8; 2],
    pending_len: usize,
    sysex: Option<Vec<u8>>,
}

impl MidiInputParser {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<MidiInputMessage>, MidiParseError> {
        let mut output = Vec::new();
        for &byte in bytes {
            if byte >= 0xf8 {
                output.push(match byte {
                    0xf8 => MidiInputMessage::Clock,
                    0xfa => MidiInputMessage::Start,
                    0xfb => MidiInputMessage::Continue,
                    0xfc => MidiInputMessage::Stop,
                    0xfe => MidiInputMessage::ActiveSensing,
                    0xff => MidiInputMessage::SystemReset,
                    value => MidiInputMessage::IgnoredSystem(value),
                });
                continue;
            }
            if let Some(sysex) = self.sysex.as_mut() {
                if byte == 0xf7 {
                    output.push(MidiInputMessage::SysEx(
                        self.sysex.take().unwrap_or_default(),
                    ));
                } else if sysex.len() == MIDI_MAX_SYSEX_BYTES {
                    self.sysex = None;
                    return Err(MidiParseError::SysExTooLarge);
                } else {
                    sysex.push(byte);
                }
                continue;
            }
            if byte == 0xf0 {
                self.running_status = None;
                self.pending_status = None;
                self.pending_len = 0;
                self.sysex = Some(Vec::new());
                continue;
            }
            if byte & 0x80 != 0 {
                self.pending_status = Some(byte);
                self.pending_len = 0;
                self.running_status = (byte < 0xf0).then_some(byte);
                if data_length(byte) == 0 {
                    self.pending_status = None;
                    output.push(MidiInputMessage::IgnoredSystem(byte));
                }
                continue;
            }
            let status = self
                .pending_status
                .or(self.running_status)
                .ok_or(MidiParseError::DataWithoutStatus)?;
            self.pending_data[self.pending_len] = byte;
            self.pending_len += 1;
            if self.pending_len == data_length(status) {
                output.push(decode(status, self.pending_data));
                self.pending_len = 0;
                self.pending_status = self.running_status;
            }
        }
        Ok(output)
    }
}

fn data_length(status: u8) -> usize {
    match status & 0xf0 {
        0xc0 | 0xd0 => 1,
        0x80..=0xe0 => 2,
        _ => match status {
            0xf2 => 2,
            0xf1 | 0xf3 => 1,
            _ => 0,
        },
    }
}

fn decode(status: u8, data: [u8; 2]) -> MidiInputMessage {
    let channel = status & 0x0f;
    match status & 0xf0 {
        0x80 => MidiInputMessage::NoteOff(channel, data[0], data[1]),
        0x90 if data[1] == 0 => MidiInputMessage::NoteOff(channel, data[0], 0),
        0x90 => MidiInputMessage::NoteOn(channel, data[0], data[1]),
        0xa0 => MidiInputMessage::PolyPressure(channel, data[0], data[1]),
        0xb0 => MidiInputMessage::ControlChange(channel, data[0], data[1]),
        0xc0 => MidiInputMessage::ProgramChange(channel, data[0]),
        0xd0 => MidiInputMessage::ChannelPressure(channel, data[0]),
        0xe0 => {
            MidiInputMessage::PitchBend(channel, u16::from(data[0]) | (u16::from(data[1]) << 7))
        }
        _ if status == 0xf2 => {
            MidiInputMessage::SongPosition(u16::from(data[0]) | (u16::from(data[1]) << 7))
        }
        _ => MidiInputMessage::IgnoredSystem(status),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MidiInputRoute {
    pub track_index: u32,
    pub port_index: Option<u32>,
    pub channel: Option<u8>,
}

#[derive(Debug, Default, Clone)]
pub struct CompiledMidiInputRoutes {
    by_port: BTreeMap<Option<u32>, Vec<MidiInputRoute>>,
}

impl CompiledMidiInputRoutes {
    #[must_use]
    pub fn new(routes: impl IntoIterator<Item = MidiInputRoute>) -> Self {
        let mut by_port: BTreeMap<Option<u32>, Vec<MidiInputRoute>> = BTreeMap::new();
        for route in routes {
            by_port.entry(route.port_index).or_default().push(route);
        }
        Self { by_port }
    }

    pub fn matching_tracks(
        &self,
        port_index: u32,
        message: &MidiInputMessage,
        output: &mut Vec<u32>,
    ) {
        output.clear();
        for key in [None, Some(port_index)] {
            if let Some(routes) = self.by_port.get(&key) {
                for route in routes {
                    if route.channel.is_none() || route.channel == message.channel() {
                        output.push(route.track_index);
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidiSyncState {
    Internal,
    Waiting,
    Locking,
    Locked,
    Freewheel,
    Lost,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MidiClockSnapshot {
    pub state: MidiSyncState,
    pub position_ticks: u64,
    pub effective_bpm: Option<f64>,
    pub jitter_micros: f64,
}

pub struct MidiClockSlave {
    enabled: bool,
    state: MidiSyncState,
    position_ticks: u64,
    last_clock_micros: Option<u64>,
    interval_micros: Option<f64>,
    jitter_micros: f64,
    clocks_seen: u32,
}

impl Default for MidiClockSlave {
    fn default() -> Self {
        Self {
            enabled: false,
            state: MidiSyncState::Internal,
            position_ticks: 0,
            last_clock_micros: None,
            interval_micros: None,
            jitter_micros: 0.0,
            clocks_seen: 0,
        }
    }
}

impl MidiClockSlave {
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.state = if enabled {
            MidiSyncState::Waiting
        } else {
            MidiSyncState::Internal
        };
        self.last_clock_micros = None;
        self.clocks_seen = 0;
    }

    pub fn receive(&mut self, message: &MidiInputMessage, timestamp_micros: u64) {
        if !self.enabled {
            return;
        }
        match message {
            MidiInputMessage::Start => {
                self.position_ticks = 0;
                self.state = MidiSyncState::Locking;
            }
            MidiInputMessage::Continue => self.state = MidiSyncState::Locking,
            MidiInputMessage::Stop => {
                self.state = MidiSyncState::Waiting;
                self.last_clock_micros = None;
            }
            MidiInputMessage::SongPosition(position) => {
                self.position_ticks = u64::from(*position) * MUSICAL_TICKS_PER_SONG_POSITION;
            }
            MidiInputMessage::Clock => self.clock(timestamp_micros),
            _ => {}
        }
    }

    fn clock(&mut self, timestamp_micros: u64) {
        if let Some(previous) = self.last_clock_micros {
            let interval = timestamp_micros.saturating_sub(previous) as f64;
            if interval > 0.0 {
                let stable = self.interval_micros.get_or_insert(interval);
                let error = interval - *stable;
                *stable += error * 0.125;
                self.jitter_micros += (error.abs() - self.jitter_micros) * 0.125;
                self.clocks_seen = self.clocks_seen.saturating_add(1);
                self.state = if self.clocks_seen >= 12 {
                    MidiSyncState::Locked
                } else {
                    MidiSyncState::Locking
                };
            }
        }
        self.last_clock_micros = Some(timestamp_micros);
        self.position_ticks = self
            .position_ticks
            .saturating_add(MUSICAL_TICKS_PER_MIDI_CLOCK);
    }

    pub fn advance(&mut self, now_micros: u64) {
        if !self.enabled || matches!(self.state, MidiSyncState::Internal | MidiSyncState::Waiting) {
            return;
        }
        let Some(last_clock) = self.last_clock_micros else {
            return;
        };
        let age = now_micros.saturating_sub(last_clock);
        if age > MIDI_CLOCK_FREEWHEEL_MICROS {
            self.state = MidiSyncState::Lost;
        } else if self
            .interval_micros
            .is_some_and(|interval| age as f64 > interval * 2.0)
        {
            self.state = MidiSyncState::Freewheel;
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> MidiClockSnapshot {
        MidiClockSnapshot {
            state: self.state,
            position_ticks: self.position_ticks,
            effective_bpm: self
                .interval_micros
                .map(|interval| 60_000_000.0 / (interval * MIDI_CLOCKS_PER_QUARTER as f64)),
            jitter_micros: self.jitter_micros,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_running_status_and_zero_velocity_note_off() {
        let mut parser = MidiInputParser::default();
        assert_eq!(
            parser.push(&[0x90, 60, 100, 61, 0]).unwrap(),
            vec![
                MidiInputMessage::NoteOn(0, 60, 100),
                MidiInputMessage::NoteOff(0, 61, 0)
            ]
        );
    }

    #[test]
    fn keeps_realtime_messages_out_of_sysex_payloads() {
        let mut parser = MidiInputParser::default();
        assert_eq!(
            parser.push(&[0xf0, 1, 0xf8, 2, 0xf7]).unwrap(),
            vec![MidiInputMessage::Clock, MidiInputMessage::SysEx(vec![1, 2])]
        );
    }

    #[test]
    fn filters_and_fans_out_routes() {
        let routes = CompiledMidiInputRoutes::new([
            MidiInputRoute {
                track_index: 1,
                port_index: None,
                channel: None,
            },
            MidiInputRoute {
                track_index: 2,
                port_index: Some(7),
                channel: Some(3),
            },
        ]);
        let mut output = Vec::new();
        routes.matching_tracks(7, &MidiInputMessage::NoteOn(3, 60, 100), &mut output);
        assert_eq!(output, vec![1, 2]);
    }

    #[test]
    fn maps_spp_clock_and_freewheel_loss() {
        let mut clock = MidiClockSlave::default();
        clock.set_enabled(true);
        clock.receive(&MidiInputMessage::SongPosition(8), 0);
        clock.receive(&MidiInputMessage::Continue, 0);
        for pulse in 1..=13 {
            clock.receive(&MidiInputMessage::Clock, pulse * 20_833);
        }
        assert_eq!(clock.snapshot().state, MidiSyncState::Locked);
        assert_eq!(
            clock.snapshot().position_ticks,
            8 * MUSICAL_TICKS_PER_SONG_POSITION + 13 * MUSICAL_TICKS_PER_MIDI_CLOCK
        );
        clock.advance(13 * 20_833 + 50_000);
        assert_eq!(clock.snapshot().state, MidiSyncState::Freewheel);
        clock.advance(13 * 20_833 + MIDI_CLOCK_FREEWHEEL_MICROS + 1);
        assert_eq!(clock.snapshot().state, MidiSyncState::Lost);
    }
}
