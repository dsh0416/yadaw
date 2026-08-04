use super::{
    ChannelSpec, LiveMidiRoute, LiveMixerSendTap, NativeMixerChannel, NativeMixerSend, Result,
    RouteTarget, SendSpec, SendTap, SignalWidth, invalid_config, parse_channel_kind,
};

pub(super) struct RoutingBuild {
    pub(super) channel_input_widths: Vec<SignalWidth>,
    pub(super) live_midi_routes: Vec<Option<LiveMidiRoute>>,
    pub(super) channels: Vec<ChannelSpec>,
    pub(super) sends: Vec<SendSpec>,
}

pub(super) fn build_routing(
    native_channels: &[NativeMixerChannel],
    native_sends: &[NativeMixerSend],
) -> Result<RoutingBuild> {
    let channel_input_widths = native_channels
        .iter()
        .map(|channel| {
            if channel.kind != "instrument" && channel.input_channels.len() == 1 {
                SignalWidth::Mono
            } else {
                SignalWidth::Stereo
            }
        })
        .collect::<Vec<_>>();
    let live_midi_routes = native_channels
        .iter()
        .map(|channel| {
            if channel.kind != "instrument" || channel.system_role.is_some() {
                return None;
            }
            Some(LiveMidiRoute {
                port_key: channel
                    .midi_input_port_id
                    .as_deref()
                    .map(crate::midi_input::stable_port_key),
                channel: channel.midi_input_channel,
                monitoring: channel.input_monitoring,
            })
        })
        .collect::<Vec<_>>();
    let channels = native_channels
        .iter()
        .map(|channel| {
            Ok(ChannelSpec {
                id: channel.id.clone(),
                kind: parse_channel_kind(&channel.kind)?,
                gain_db: channel.gain_db as f32,
                pan: channel.pan as f32,
                muted: channel.muted,
                soloed: channel.soloed,
                output: match (channel.output_index, channel.output_bus) {
                    (Some(index), None) => Some(RouteTarget::Output(index as usize)),
                    (None, Some(bus)) => Some(RouteTarget::Bus(
                        bus.checked_sub(1)
                            .ok_or_else(|| invalid_config("BUS channels are one-based"))?
                            as usize,
                    )),
                    (None, None) => None,
                    (Some(_), Some(_)) => {
                        return Err(invalid_config(
                            "channel output must target either a BUS or an Output",
                        ));
                    }
                },
                input_bus: if channel.input_source.as_deref() == Some("bus") {
                    match channel.input_channels.as_slice() {
                        [mono] if *mono > 0 => Some([(*mono - 1) as usize; 2]),
                        [left, right] if *left > 0 && *right > 0 => {
                            Some([(*left - 1) as usize, (*right - 1) as usize])
                        }
                        _ => return Err(invalid_config("invalid BUS input mapping")),
                    }
                } else {
                    None
                },
                hardware_output: match channel.hardware_output_channels.as_slice() {
                    [] => None,
                    [left, right] if *left > 0 && *right > 0 => {
                        Some([(*left - 1) as usize, (*right - 1) as usize])
                    }
                    _ => return Err(invalid_config("invalid hardware output mapping")),
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let sends = native_sends
        .iter()
        .map(|send| {
            Ok(SendSpec {
                id: send.id.clone(),
                source: send.source_index as usize,
                target: match (send.target_output_index, send.target_bus) {
                    (Some(index), None) => RouteTarget::Output(index as usize),
                    (None, Some(bus)) => RouteTarget::Bus(
                        bus.checked_sub(1)
                            .ok_or_else(|| invalid_config("BUS channels are one-based"))?
                            as usize,
                    ),
                    _ => {
                        return Err(invalid_config("send must target either a BUS or an Output"));
                    }
                },
                enabled: send.enabled,
                tap: match send.tap {
                    LiveMixerSendTap::Pre => SendTap::Pre,
                    LiveMixerSendTap::Post => SendTap::Post,
                    LiveMixerSendTap::PostPan => SendTap::PostPan,
                },
                level_db: send.level_db as f32,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(RoutingBuild {
        channel_input_widths,
        live_midi_routes,
        channels,
        sends,
    })
}
