//! Shared visual language for Heron's built-in iced plug-ins.

mod widgets;

pub use widgets::{LevelMeter, ParameterKnob, level_meter, parameter_knob};

pub use heron_iced_ui::{self, Appearance, SemanticPalette, space, type_size};

use iced_widget::Theme;

/// Fixed dark palette used inside built-in plug-in content.
#[must_use]
pub const fn palette() -> SemanticPalette {
    Appearance::Dark.palette()
}

/// Fixed dark iced theme used inside built-in plug-in content.
#[must_use]
pub fn theme() -> Theme {
    Appearance::Dark.theme()
}

/// Logical editor size for Heron Sine.
pub const SINE_EDITOR_SIZE: (u32, u32) = (520, 300);
/// Logical editor size for Heron Gain.
pub const GAIN_EDITOR_SIZE: (u32, u32) = (380, 260);
/// Logical editor size for Heron Metronome.
pub const METRONOME_EDITOR_SIZE: (u32, u32) = (600, 300);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_content_stays_on_the_shared_dark_palette() {
        assert_eq!(palette(), Appearance::Dark.palette());
        assert_ne!(palette().canvas, palette().surface);
    }
}
