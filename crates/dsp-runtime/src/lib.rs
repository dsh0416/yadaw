#![forbid(unsafe_code)]

pub mod block;
pub mod midi;
pub mod protocol;
pub mod tempo;

pub const MUSICAL_TICKS_PER_QUARTER: u32 = 960;
