#![forbid(unsafe_code)]

pub mod block;
pub mod low_latency;
pub mod midi;
pub mod midi_input;
pub mod midi_journal;
pub mod protocol;
pub mod tempo;

pub const MUSICAL_TICKS_PER_QUARTER: u32 = 960;
