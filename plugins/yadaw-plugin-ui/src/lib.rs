//! Shared visual constants for YADAW's built-in plug-ins.

/// Fixed dark canvas color used by all built-in plug-in editors.
pub const CANVAS: [u8; 4] = [0x0E, 0x10, 0x14, 0xFF];
/// Raised control-surface color used by all built-in plug-in editors.
pub const SURFACE: [u8; 4] = [0x1D, 0x21, 0x28, 0xFF];
/// Primary editor text color.
pub const TEXT: [u8; 4] = [0xF6, 0xF7, 0xF9, 0xFF];
/// Accent used by the Sine instrument.
pub const MIDI_ACCENT: [u8; 4] = [0xAD, 0x8C, 0xFF, 0xFF];
/// Accent used by the Gain effect.
pub const AUDIO_ACCENT: [u8; 4] = [0x58, 0xC6, 0xC2, 0xFF];

/// Logical editor size for YADAW Sine.
pub const SINE_EDITOR_SIZE: (u32, u32) = (520, 300);
/// Logical editor size for YADAW Gain.
pub const GAIN_EDITOR_SIZE: (u32, u32) = (380, 260);
/// Logical editor size for YADAW Metronome.
pub const METRONOME_EDITOR_SIZE: (u32, u32) = (600, 300);
