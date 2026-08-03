use std::collections::{HashMap, HashSet};

use heron_dsp_runtime::{
    block::{LatencyNode, plan_latency_compensation},
    low_latency::{LowLatencyChannel, LowLatencyPlugin, plan_low_latency},
    protocol::{LiveLatencyPolicy, LiveMixerGraph},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PresentationLatency {
    pub(crate) input_samples: u32,
    pub(crate) output_samples: u32,
}

#[derive(Clone, Copy)]
struct PresentationEdge {
    source: usize,
}

pub(crate) fn calculate_presentation_latencies(
    graph: &LiveMixerGraph,
    input_device_samples: u32,
    output_pipeline_samples: u32,
) -> Result<HashMap<String, PresentationLatency>, String> {
    let channel_indexes = graph
        .channels
        .iter()
        .enumerate()
        .map(|(index, channel)| (channel.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let plugin_channel_indexes = graph
        .plugins
        .iter()
        .map(|plugin| {
            channel_indexes
                .get(plugin.channel_id.as_str())
                .copied()
                .ok_or_else(|| {
                    format!(
                        "presentation latency references missing channel `{}`",
                        plugin.channel_id
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let low_latency_bypassed = match &graph.latency_policy {
        LiveLatencyPolicy::Normal => HashSet::new(),
        LiveLatencyPolicy::LowLatency {
            target_output_channel_id,
            plugin_budget_samples,
        } => {
            let Some(&target) = channel_indexes.get(target_output_channel_id.as_str()) else {
                return Err("low-latency presentation target is missing".to_owned());
            };
            plan_low_latency(
                &graph
                    .channels
                    .iter()
                    .map(|channel| LowLatencyChannel {
                        output: channel
                            .output_channel_id
                            .as_deref()
                            .and_then(|id| channel_indexes.get(id).copied()),
                        input_buses: if channel.input_source.as_deref() == Some("bus") {
                            channel.input_channels.clone()
                        } else {
                            Vec::new()
                        },
                        output_bus: channel.output_bus,
                        monitored: channel.input_monitoring
                            && (channel.kind == "instrument"
                                || channel.input_source.as_deref() == Some("hardware")),
                    })
                    .collect::<Vec<_>>(),
                &graph
                    .plugins
                    .iter()
                    .zip(&plugin_channel_indexes)
                    .map(|(plugin, &channel)| LowLatencyPlugin {
                        instance_id: plugin.instance_id.clone(),
                        channel,
                        slot_order: plugin.slot_order,
                        latency_samples: plugin.latency_samples,
                        instrument: plugin.role == "instrument",
                    })
                    .collect::<Vec<_>>(),
                target,
                *plugin_budget_samples,
            )
            .bypassed_plugin_instance_ids
            .into_iter()
            .collect()
        }
    };
    let mut plugins_by_channel = (0..graph.channels.len())
        .map(|_| Vec::new())
        .collect::<Vec<Vec<_>>>();
    for (plugin, &channel) in graph.plugins.iter().zip(&plugin_channel_indexes) {
        plugins_by_channel[channel].push(plugin);
    }
    for plugins in &mut plugins_by_channel {
        plugins.sort_by_key(|plugin| {
            (
                if plugin.role == "instrument" { 0 } else { 1 },
                plugin.slot_order,
            )
        });
    }

    let plugin_latencies = plugins_by_channel
        .iter()
        .map(|plugins| {
            plugins.iter().try_fold(0_u32, |total, plugin| {
                // Disabled plug-ins are latency-preserving bypass nodes in the render runtime:
                // `LivePlugin::process_block` routes them through a delay line sized to the
                // plug-in latency. Keep that delay in both PDC and presentation calculations.
                total
                    .checked_add(if low_latency_bypassed.contains(&plugin.instance_id) {
                        0
                    } else {
                        plugin.latency_samples
                    })
                    .ok_or_else(|| "presentation latency exceeds the supported range".to_owned())
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let input_bases = graph
        .channels
        .iter()
        .map(|channel| {
            if channel.input_source.as_deref() == Some("hardware")
                && (channel.input_monitoring || channel.record_armed)
            {
                input_device_samples
            } else {
                0
            }
        })
        .collect::<Vec<_>>();
    let mut input_edges = (0..graph.channels.len())
        .map(|_| Vec::new())
        .collect::<Vec<Vec<PresentationEdge>>>();

    let mut add_route = |source: usize,
                         target_channel_id: Option<&str>,
                         target_bus: Option<u32>|
     -> Result<(), String> {
        match (target_channel_id, target_bus) {
            (Some(target), None) => {
                let Some(&target) = channel_indexes.get(target) else {
                    return Err(format!(
                        "presentation latency references missing channel `{target}`"
                    ));
                };
                input_edges[target].push(PresentationEdge { source });
            }
            (None, Some(bus)) if bus > 0 => {
                for (target, channel) in graph.channels.iter().enumerate() {
                    if channel.input_source.as_deref() == Some("bus")
                        && channel.input_channels.contains(&bus)
                    {
                        input_edges[target].push(PresentationEdge { source });
                    }
                }
            }
            (None, None) => {}
            _ => return Err("presentation latency route target is invalid".to_owned()),
        }
        Ok(())
    };
    for (source, channel) in graph.channels.iter().enumerate() {
        add_route(
            source,
            channel.output_channel_id.as_deref(),
            channel.output_bus,
        )?;
    }
    for send in graph.sends.iter().filter(|send| send.enabled) {
        let Some(&source) = channel_indexes.get(send.source_channel_id.as_str()) else {
            return Err(format!(
                "presentation latency references missing channel `{}`",
                send.source_channel_id
            ));
        };
        add_route(source, send.target_channel_id.as_deref(), send.target_bus)?;
    }

    let nodes = input_edges
        .iter()
        .enumerate()
        .map(|(index, edges)| {
            Ok(LatencyNode {
                id: graph.channels[index].id.clone(),
                intrinsic_latency: plugin_latencies[index]
                    .checked_add(input_bases[index])
                    .ok_or_else(|| {
                        "presentation input latency exceeds the supported range".to_owned()
                    })?,
                inputs: edges.iter().map(|edge| edge.source).collect(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let plan = plan_latency_compensation(&nodes).map_err(|error| error.to_string())?;
    let mut output_edges = (0..graph.channels.len())
        .map(|_| Vec::new())
        .collect::<Vec<Vec<(usize, u32)>>>();
    for (target, edges) in input_edges.iter().enumerate() {
        for (input, edge) in edges.iter().enumerate() {
            output_edges[edge.source].push((target, plan[target].input_delays[input]));
        }
    }
    let output_bases = graph
        .channels
        .iter()
        .map(|channel| {
            if channel.hardware_output_channels.is_empty() {
                0
            } else {
                output_pipeline_samples
            }
        })
        .collect::<Vec<_>>();
    let mut downstream_states = vec![0_u8; graph.channels.len()];
    let mut downstream_latencies = vec![0_u32; graph.channels.len()];
    for channel in 0..graph.channels.len() {
        visit_downstream_latency(
            channel,
            &output_edges,
            &plugin_latencies,
            &output_bases,
            &mut downstream_states,
            &mut downstream_latencies,
        )?;
    }

    let mut result = HashMap::with_capacity(graph.plugins.len());
    for (channel, plugins) in plugins_by_channel.iter().enumerate() {
        let channel_input = plan[channel]
            .total_latency
            .checked_sub(plugin_latencies[channel])
            .ok_or_else(|| "presentation input latency underflowed".to_owned())?;
        let mut prior = 0_u32;
        let mut remaining = plugin_latencies[channel];
        for plugin in plugins {
            let plugin_latency = if low_latency_bypassed.contains(&plugin.instance_id) {
                0
            } else {
                plugin.latency_samples
            };
            remaining = remaining
                .checked_sub(plugin_latency)
                .ok_or_else(|| "presentation output latency underflowed".to_owned())?;
            result.insert(
                plugin.instance_id.clone(),
                PresentationLatency {
                    input_samples: channel_input.checked_add(prior).ok_or_else(|| {
                        "presentation input latency exceeds the supported range".to_owned()
                    })?,
                    output_samples: remaining
                        .checked_add(downstream_latencies[channel])
                        .ok_or_else(|| {
                            "presentation output latency exceeds the supported range".to_owned()
                        })?,
                },
            );
            prior = prior.checked_add(plugin_latency).ok_or_else(|| {
                "presentation input latency exceeds the supported range".to_owned()
            })?;
        }
    }
    Ok(result)
}

fn visit_downstream_latency(
    channel: usize,
    output_edges: &[Vec<(usize, u32)>],
    plugin_latencies: &[u32],
    output_bases: &[u32],
    states: &mut [u8],
    latencies: &mut [u32],
) -> Result<u32, String> {
    match states[channel] {
        1 => return Err("presentation latency graph contains a cycle".to_owned()),
        2 => return Ok(latencies[channel]),
        _ => {}
    }
    states[channel] = 1;
    let mut latency = output_bases[channel];
    for &(target, compensation) in &output_edges[channel] {
        let downstream = visit_downstream_latency(
            target,
            output_edges,
            plugin_latencies,
            output_bases,
            states,
            latencies,
        )?;
        let candidate = compensation
            .checked_add(plugin_latencies[target])
            .and_then(|value| value.checked_add(downstream))
            .ok_or_else(|| "presentation output latency exceeds the supported range".to_owned())?;
        latency = latency.max(candidate);
    }
    latencies[channel] = latency;
    states[channel] = 2;
    Ok(latency)
}

#[cfg(test)]
mod tests {
    use super::*;
    use heron_dsp_runtime::protocol::{
        LiveMixerChannel, LiveMixerSystemRole, LivePluginInstance, PluginAudioMode,
    };

    fn channel(
        id: &str,
        input_source: Option<&str>,
        output: Option<&str>,
        hardware_output: bool,
    ) -> LiveMixerChannel {
        LiveMixerChannel {
            id: id.to_owned(),
            name: id.to_owned(),
            color: String::new(),
            kind: "audio".to_owned(),
            system_role: None::<LiveMixerSystemRole>,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output_channel_id: output.map(str::to_owned),
            output_bus: None,
            record_armed: false,
            input_monitoring: input_source == Some("hardware"),
            midi_input_port_id: None,
            midi_input_port_name: None,
            midi_input_channel: None,
            input_source: input_source.map(str::to_owned),
            input_channels: if input_source.is_some() {
                vec![1, 2]
            } else {
                Vec::new()
            },
            hardware_output_channels: if hardware_output {
                vec![1, 2]
            } else {
                Vec::new()
            },
        }
    }

    fn plugin(
        id: &str,
        channel_id: &str,
        slot_order: u32,
        latency_samples: u32,
    ) -> LivePluginInstance {
        LivePluginInstance {
            instance_id: id.to_owned(),
            channel_id: channel_id.to_owned(),
            role: "effect".to_owned(),
            slot_order,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: Vec::new(),
            latency_samples,
            tail_samples: Some(0),
        }
    }

    fn graph(channels: Vec<LiveMixerChannel>, plugins: Vec<LivePluginInstance>) -> LiveMixerGraph {
        LiveMixerGraph {
            sample_rate: 48_000,
            latency_policy: LiveLatencyPolicy::Normal,
            channels,
            sends: Vec::new(),
            clips: Vec::new(),
            plugins,
            midi_clips: Vec::new(),
            tempo_events: Vec::new(),
            time_signature_events: Vec::new(),
        }
    }

    #[test]
    fn tracks_device_and_plugins_on_both_sides() {
        let graph = graph(
            vec![
                channel("track", Some("hardware"), Some("master"), false),
                channel("master", None, None, true),
            ],
            vec![
                plugin("first", "track", 0, 64),
                plugin("second", "track", 1, 32),
                plugin("master-fx", "master", 0, 16),
            ],
        );

        let latency = calculate_presentation_latencies(&graph, 10, 20).unwrap();
        assert_eq!(
            latency["first"],
            PresentationLatency {
                input_samples: 10,
                output_samples: 68,
            }
        );
        assert_eq!(
            latency["second"],
            PresentationLatency {
                input_samples: 74,
                output_samples: 36,
            }
        );
        assert_eq!(
            latency["master-fx"],
            PresentationLatency {
                input_samples: 106,
                output_samples: 20,
            }
        );
    }

    #[test]
    fn includes_pdc_delay_on_the_shorter_merge_path() {
        let graph = graph(
            vec![
                channel("slow", None, Some("master"), false),
                channel("fast", None, Some("master"), false),
                channel("master", None, None, true),
            ],
            vec![
                plugin("slow-fx", "slow", 0, 64),
                plugin("fast-fx", "fast", 0, 16),
            ],
        );

        let latency = calculate_presentation_latencies(&graph, 0, 0).unwrap();
        assert_eq!(latency["slow-fx"].output_samples, 0);
        assert_eq!(latency["fast-fx"].output_samples, 48);
    }

    #[test]
    fn bypassed_plugins_keep_the_render_paths_latency_preserving_delay() {
        let mut bypassed = plugin("bypassed", "track", 0, 64);
        bypassed.enabled = false;
        let graph = graph(
            vec![channel("track", Some("hardware"), None, true)],
            vec![bypassed, plugin("active", "track", 1, 32)],
        );

        let latency = calculate_presentation_latencies(&graph, 10, 20).unwrap();
        assert_eq!(
            latency["bypassed"],
            PresentationLatency {
                input_samples: 10,
                output_samples: 52,
            }
        );
        assert_eq!(
            latency["active"],
            PresentationLatency {
                input_samples: 74,
                output_samples: 20,
            }
        );
    }

    #[test]
    fn missing_plugin_channel_returns_an_error_in_low_latency_mode() {
        let mut graph = graph(
            vec![channel("output", None, None, true)],
            vec![plugin("orphan", "missing", 0, 64)],
        );
        graph.latency_policy = LiveLatencyPolicy::LowLatency {
            target_output_channel_id: "output".to_owned(),
            plugin_budget_samples: 0,
        };

        assert_eq!(
            calculate_presentation_latencies(&graph, 0, 0),
            Err("presentation latency references missing channel `missing`".to_owned())
        );
    }
}
