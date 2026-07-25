use std::{error::Error, fmt};

pub mod mixer;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProcessStats {
    pub peak: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DspError {
    NonFiniteGain,
}

impl fmt::Display for DspError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteGain => formatter.write_str("gain must be finite"),
        }
    }
}

impl Error for DspError {}

pub fn apply_gain(samples: &mut [f32], gain: f32) -> Result<ProcessStats, DspError> {
    if !gain.is_finite() {
        return Err(DspError::NonFiniteGain);
    }

    let mut peak = 0.0_f32;
    for sample in samples {
        *sample *= gain;
        peak = peak.max(sample.abs());
    }

    Ok(ProcessStats { peak })
}

#[cfg(test)]
mod tests {
    use super::{DspError, apply_gain};

    #[test]
    fn applies_gain_and_reports_peak() {
        let mut samples = [-0.5, 0.25, 1.0];

        let stats = apply_gain(&mut samples, 0.5).expect("valid gain");

        assert_eq!(samples, [-0.25, 0.125, 0.5]);
        assert_eq!(stats.peak, 0.5);
    }

    #[test]
    fn rejects_non_finite_gain() {
        let mut samples = [1.0];

        let error = apply_gain(&mut samples, f32::NAN).expect_err("NaN must be rejected");

        assert_eq!(error, DspError::NonFiniteGain);
        assert_eq!(samples, [1.0]);
    }
}
