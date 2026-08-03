//! Pure low-latency monitoring path planning.

use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowLatencyChannel {
    pub output: Option<usize>,
    pub input_buses: Vec<u32>,
    pub output_bus: Option<u32>,
    pub monitored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowLatencyPlugin {
    pub instance_id: String,
    pub channel: usize,
    pub slot_order: u32,
    pub latency_samples: u32,
    pub instrument: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LowLatencyPlan {
    pub sensitive_channels: Vec<bool>,
    pub bypassed_plugin_instance_ids: Vec<String>,
    pub unavoidable_latency_samples: u32,
    pub has_monitoring_path: bool,
}

/// Plans only dry/main routes. Sends and side-chains deliberately do not participate.
#[must_use]
pub fn plan_low_latency(
    channels: &[LowLatencyChannel],
    plugins: &[LowLatencyPlugin],
    target: usize,
    budget_samples: u32,
) -> LowLatencyPlan {
    if target >= channels.len() {
        return LowLatencyPlan {
            sensitive_channels: vec![false; channels.len()],
            ..Default::default()
        };
    }
    let mut adjacency = vec![Vec::new(); channels.len()];
    for (source, channel) in channels.iter().enumerate() {
        if let Some(output) = channel.output.filter(|output| *output < channels.len()) {
            adjacency[source].push(output);
        }
        if let Some(bus) = channel.output_bus {
            for (consumer, candidate) in channels.iter().enumerate() {
                if candidate.input_buses.contains(&bus) {
                    adjacency[source].push(consumer);
                }
            }
        }
    }
    let mut paths = Vec::<Vec<usize>>::new();
    for root in channels
        .iter()
        .enumerate()
        .filter_map(|(index, channel)| channel.monitored.then_some(index))
    {
        let mut path = Vec::new();
        let mut visiting = vec![false; channels.len()];
        collect_paths(
            root,
            target,
            &adjacency,
            &mut visiting,
            &mut path,
            &mut paths,
        );
    }
    let mut sensitive_channels = vec![false; channels.len()];
    for path in &paths {
        for &channel in path {
            sensitive_channels[channel] = true;
        }
    }
    let path_plugins = paths
        .iter()
        .map(|path| {
            plugins
                .iter()
                .enumerate()
                .filter_map(|(index, plugin)| path.contains(&plugin.channel).then_some(index))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let unavoidable_latency_samples = path_plugins
        .iter()
        .map(|path| {
            path.iter()
                .filter(|&&index| plugins[index].instrument)
                .fold(0_u32, |sum, &index| {
                    sum.saturating_add(plugins[index].latency_samples)
                })
        })
        .max()
        .unwrap_or(0);
    let mut bypassed = HashSet::new();
    loop {
        let over_budget = path_plugins.iter().filter(|path| {
            path.iter()
                .filter(|&&index| !bypassed.contains(&index))
                .fold(0_u32, |sum, &index| {
                    sum.saturating_add(plugins[index].latency_samples)
                })
                > budget_samples
        });
        let candidate = over_budget
            .flat_map(|path| path.iter().copied())
            .filter(|index| {
                !plugins[*index].instrument
                    && plugins[*index].latency_samples > 0
                    && !bypassed.contains(index)
            })
            .max_by(|left, right| {
                plugins[*left]
                    .latency_samples
                    .cmp(&plugins[*right].latency_samples)
                    .then_with(|| right.cmp(left))
                    .then_with(|| plugins[*right].slot_order.cmp(&plugins[*left].slot_order))
                    .then_with(|| plugins[*right].instance_id.cmp(&plugins[*left].instance_id))
            });
        let Some(candidate) = candidate else { break };
        bypassed.insert(candidate);
    }
    let mut bypassed_plugin_instance_ids = bypassed
        .into_iter()
        .map(|index| (index, plugins[index].instance_id.clone()))
        .collect::<Vec<_>>();
    bypassed_plugin_instance_ids.sort_by_key(|(index, _)| *index);
    LowLatencyPlan {
        sensitive_channels,
        bypassed_plugin_instance_ids: bypassed_plugin_instance_ids
            .into_iter()
            .map(|(_, id)| id)
            .collect(),
        unavoidable_latency_samples,
        has_monitoring_path: !paths.is_empty(),
    }
}

fn collect_paths(
    current: usize,
    target: usize,
    adjacency: &[Vec<usize>],
    visiting: &mut [bool],
    path: &mut Vec<usize>,
    paths: &mut Vec<Vec<usize>>,
) {
    if visiting[current] {
        return;
    }
    visiting[current] = true;
    path.push(current);
    if current == target {
        paths.push(path.clone());
    } else {
        for &next in &adjacency[current] {
            collect_paths(next, target, adjacency, visiting, path, paths);
        }
    }
    path.pop();
    visiting[current] = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optimizes_only_paths_to_the_selected_output_with_stable_largest_first_bypass() {
        let channels = vec![
            LowLatencyChannel {
                output: Some(2),
                input_buses: vec![],
                output_bus: None,
                monitored: true,
            },
            LowLatencyChannel {
                output: Some(3),
                input_buses: vec![],
                output_bus: None,
                monitored: true,
            },
            LowLatencyChannel {
                output: None,
                input_buses: vec![],
                output_bus: None,
                monitored: false,
            },
            LowLatencyChannel {
                output: None,
                input_buses: vec![],
                output_bus: None,
                monitored: false,
            },
        ];
        let plugins = vec![
            LowLatencyPlugin {
                instance_id: "small".into(),
                channel: 0,
                slot_order: 0,
                latency_samples: 80,
                instrument: false,
            },
            LowLatencyPlugin {
                instance_id: "large".into(),
                channel: 2,
                slot_order: 0,
                latency_samples: 240,
                instrument: false,
            },
            LowLatencyPlugin {
                instance_id: "other-output".into(),
                channel: 3,
                slot_order: 0,
                latency_samples: 999,
                instrument: false,
            },
        ];
        let plan = plan_low_latency(&channels, &plugins, 2, 100);
        assert_eq!(plan.sensitive_channels, vec![true, false, true, false]);
        assert_eq!(plan.bypassed_plugin_instance_ids, vec!["large"]);
    }

    #[test]
    fn instrument_latency_is_unavoidable_and_does_not_fail_the_plan() {
        let channels = vec![
            LowLatencyChannel {
                output: Some(1),
                input_buses: vec![],
                output_bus: None,
                monitored: true,
            },
            LowLatencyChannel {
                output: None,
                input_buses: vec![],
                output_bus: None,
                monitored: false,
            },
        ];
        let plugins = vec![LowLatencyPlugin {
            instance_id: "instrument".into(),
            channel: 0,
            slot_order: 0,
            latency_samples: 512,
            instrument: true,
        }];
        let plan = plan_low_latency(&channels, &plugins, 1, 0);
        assert!(plan.bypassed_plugin_instance_ids.is_empty());
        assert_eq!(plan.unavoidable_latency_samples, 512);
        assert!(plan.has_monitoring_path);
    }

    #[test]
    fn follows_shared_bus_main_routes_but_ignores_unmonitored_and_send_only_branches() {
        let channels = vec![
            LowLatencyChannel {
                output: None,
                input_buses: vec![],
                output_bus: Some(7),
                monitored: true,
            },
            LowLatencyChannel {
                output: None,
                input_buses: vec![],
                output_bus: Some(8),
                monitored: false,
            },
            LowLatencyChannel {
                output: Some(3),
                input_buses: vec![7],
                output_bus: None,
                monitored: false,
            },
            LowLatencyChannel {
                output: None,
                input_buses: vec![],
                output_bus: None,
                monitored: false,
            },
        ];
        let plugins = vec![
            LowLatencyPlugin {
                instance_id: "shared-bus".into(),
                channel: 2,
                slot_order: 0,
                latency_samples: 240,
                instrument: false,
            },
            LowLatencyPlugin {
                instance_id: "playback".into(),
                channel: 1,
                slot_order: 0,
                latency_samples: 2_000,
                instrument: false,
            },
        ];
        let plan = plan_low_latency(&channels, &plugins, 3, 0);
        assert_eq!(plan.sensitive_channels, vec![true, false, true, true]);
        assert_eq!(plan.bypassed_plugin_instance_ids, vec!["shared-bus"]);
    }
}
