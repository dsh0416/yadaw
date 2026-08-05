use super::{MAX_INPUT_CHANNELS, NativeMixerChannel, Result, invalid_config};

pub(super) fn validate_sample_rate(sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(invalid_config("mixer sample rate must be positive"));
    }
    Ok(())
}

pub(super) struct InputRoutes {
    pub(super) meter: Vec<Option<[usize; 2]>>,
    pub(super) monitor: Vec<Option<[usize; 2]>>,
    pub(super) source: Vec<Option<[usize; 2]>>,
}

pub(super) fn build_input_routes(channels: &[NativeMixerChannel]) -> Result<InputRoutes> {
    let input_meter_routes = channels
        .iter()
        .map(|channel| {
            if channel.kind != "audio"
                || channel.input_source.as_deref() != Some("hardware")
                || !channel.record_armed
                || channel.input_monitoring
            {
                return Ok(None);
            }
            let routed = channel
                .input_channels
                .iter()
                .map(|channel| channel.saturating_sub(1) as usize)
                .collect::<Vec<_>>();
            if routed.is_empty()
                || routed.len() > 2
                || routed.iter().any(|&channel| channel >= MAX_INPUT_CHANNELS)
            {
                return Err(invalid_config("armed track has an invalid input mapping"));
            }
            Ok(Some([routed[0], *routed.get(1).unwrap_or(&routed[0])]))
        })
        .collect::<Result<Vec<_>>>()?;
    let monitor_input_routes = channels
        .iter()
        .map(|channel| {
            if !matches!(channel.kind.as_str(), "audio" | "aux")
                || channel.input_source.as_deref() != Some("hardware")
                || !channel.input_monitoring
            {
                return Ok(None);
            }
            let routed = channel
                .input_channels
                .iter()
                .map(|channel| channel.saturating_sub(1) as usize)
                .collect::<Vec<_>>();
            if routed.is_empty()
                || routed.len() > 2
                || routed.iter().any(|&channel| channel >= MAX_INPUT_CHANNELS)
            {
                return Err(invalid_config(
                    "monitored track has an invalid input mapping",
                ));
            }
            Ok(Some([routed[0], *routed.get(1).unwrap_or(&routed[0])]))
        })
        .collect::<Result<Vec<_>>>()?;
    let source_input_routes = channels
        .iter()
        .map(|channel| {
            if !matches!(channel.kind.as_str(), "audio" | "aux")
                || channel.input_source.as_deref() != Some("hardware")
                || (!channel.input_monitoring && !channel.record_armed)
            {
                return Ok(None);
            }
            let routed = channel
                .input_channels
                .iter()
                .map(|channel| channel.saturating_sub(1) as usize)
                .collect::<Vec<_>>();
            if routed.is_empty()
                || routed.len() > 2
                || routed.iter().any(|&channel| channel >= MAX_INPUT_CHANNELS)
            {
                return Err(invalid_config(
                    "input source has an invalid channel mapping",
                ));
            }
            Ok(Some([routed[0], *routed.get(1).unwrap_or(&routed[0])]))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(InputRoutes {
        meter: input_meter_routes,
        monitor: monitor_input_routes,
        source: source_input_routes,
    })
}
