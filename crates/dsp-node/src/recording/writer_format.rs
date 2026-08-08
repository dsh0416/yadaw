use super::*;

pub(crate) fn recording_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

pub(crate) fn float_format(sample_rate: u32, channels: usize) -> WaveFmt {
    let channels = channels.clamp(1, u16::MAX as usize) as u16;
    let block_alignment = channels.saturating_mul(4);
    WaveFmt {
        tag: WAVE_TAG_FLOAT,
        channel_count: channels,
        sample_rate,
        bytes_per_second: sample_rate.saturating_mul(u32::from(block_alignment)),
        block_alignment,
        bits_per_sample: 32,
        extended_format: None,
    }
}

pub(super) fn float_stereo_format(sample_rate: u32) -> WaveFmt {
    float_format(sample_rate, 2)
}

pub(super) fn pcm_stereo_format(sample_rate: u32, bits_per_sample: u16) -> WaveFmt {
    WaveFmt::new_pcm_stereo(sample_rate, bits_per_sample)
}

pub(crate) fn broadcast_metadata(
    asset_id: &str,
    originator: &str,
    origination_date: &str,
    origination_time: &str,
    time_reference: u64,
    coding_history: String,
) -> Bext {
    Bext {
        description: format!("Heron recording {asset_id}"),
        originator: originator.to_owned(),
        originator_reference: asset_id.to_owned(),
        origination_date: origination_date.to_owned(),
        origination_time: origination_time.to_owned(),
        time_reference,
        version: 1,
        umid: None,
        loudness_value: None,
        loudness_range: None,
        max_true_peak_level: None,
        max_momentary_loudness: None,
        max_short_term_loudness: None,
        coding_history,
    }
}
