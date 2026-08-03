use super::*;

pub(super) fn compiled_graph_snapshot(
    native: &NativeMixerGraph,
    build_generation: u64,
) -> CompiledAudioGraphSnapshot {
    let low_latency_plan = plan_native_low_latency(native);
    let low_latency_bypassed = low_latency_plan
        .bypassed_plugin_instance_ids
        .iter()
        .collect::<std::collections::HashSet<_>>();
    fn edge(
        edges: &mut Vec<CompiledGraphEdge>,
        source: &str,
        target: &str,
        kind: CompiledGraphEdgeKind,
        width: CompiledGraphSignalWidth,
    ) {
        edges.push(CompiledGraphEdge {
            id: format!("{source}->{target}:{}", edges.len()),
            source: source.to_owned(),
            target: target.to_owned(),
            kind,
            signal_width: width,
            target_input_bus_index: None,
        });
    }

    fn plugin_input_width(mode: PluginAudioMode) -> CompiledGraphSignalWidth {
        match mode {
            PluginAudioMode::Mono | PluginAudioMode::MonoToStereo => CompiledGraphSignalWidth::Mono,
            PluginAudioMode::Stereo | PluginAudioMode::DualMono => CompiledGraphSignalWidth::Stereo,
        }
    }

    fn plugin_output_width(mode: PluginAudioMode) -> CompiledGraphSignalWidth {
        match mode {
            PluginAudioMode::Mono => CompiledGraphSignalWidth::Mono,
            PluginAudioMode::MonoToStereo | PluginAudioMode::Stereo | PluginAudioMode::DualMono => {
                CompiledGraphSignalWidth::Stereo
            }
        }
    }

    #[derive(Clone, Copy)]
    enum DiagnosticInputEdge {
        Main(usize),
        Send(usize),
        Sidechain { source: usize },
    }

    let mut input_edges = (0..native.channels.len())
        .map(|_| Vec::new())
        .collect::<Vec<Vec<DiagnosticInputEdge>>>();
    for (source, channel) in native.channels.iter().enumerate() {
        if let Some(target) = channel.output_index {
            if let Some(edges) = input_edges.get_mut(target as usize) {
                edges.push(DiagnosticInputEdge::Main(source));
            }
        } else if let Some(bus) = channel.output_bus {
            for (target, consumer) in native.channels.iter().enumerate() {
                if consumer.input_source.as_deref() == Some("bus")
                    && consumer.input_channels.contains(&bus)
                {
                    input_edges[target].push(DiagnosticInputEdge::Main(source));
                }
            }
        }
    }
    for (send_index, send) in native.sends.iter().enumerate() {
        if !send.enabled {
            continue;
        }
        if let Some(target) = send.target_output_index {
            if let Some(edges) = input_edges.get_mut(target as usize) {
                edges.push(DiagnosticInputEdge::Send(send_index));
            }
        } else if let Some(bus) = send.target_bus {
            for (target, consumer) in native.channels.iter().enumerate() {
                if consumer.input_source.as_deref() == Some("bus")
                    && consumer.input_channels.contains(&bus)
                {
                    input_edges[target].push(DiagnosticInputEdge::Send(send_index));
                }
            }
        }
    }
    for plugin in &native.plugins {
        let target = plugin.channel_index as usize;
        for bus in &plugin.aux_input_buses {
            if let (Some(source), Some(edges)) = (bus.source_index, input_edges.get_mut(target)) {
                edges.push(DiagnosticInputEdge::Sidechain {
                    source: source as usize,
                });
            }
        }
    }
    let mut channel_output_delays = vec![0_u32; native.channels.len()];
    let mut send_delays = vec![0_u32; native.sends.len()];
    let mut sidechain_delays = std::collections::HashMap::new();
    let mut main_slot_delays = std::collections::HashMap::new();
    let mut adjacency = vec![Vec::new(); native.channels.len()];
    let mut indegree = vec![0_usize; native.channels.len()];
    for (target, inputs) in input_edges.iter().enumerate() {
        for source in inputs.iter().filter_map(|edge| match edge {
            DiagnosticInputEdge::Main(source) => Some(*source),
            DiagnosticInputEdge::Send(send) => native
                .sends
                .get(*send)
                .map(|send| send.source_index as usize),
            DiagnosticInputEdge::Sidechain { source, .. } => Some(*source),
        }) {
            adjacency[source].push(target);
            indegree[target] += 1;
        }
    }
    let mut ready = std::collections::VecDeque::new();
    for (index, degree) in indegree.iter().enumerate() {
        if *degree == 0 {
            ready.push_back(index);
        }
    }
    let mut order = Vec::with_capacity(native.channels.len());
    while let Some(source) = ready.pop_front() {
        order.push(source);
        for target in &adjacency[source] {
            indegree[*target] = indegree[*target].saturating_sub(1);
            if indegree[*target] == 0 {
                ready.push_back(*target);
            }
        }
    }
    let mut channel_latencies = vec![0_u32; native.channels.len()];
    for target in order {
        let latency_sensitive = low_latency_plan.sensitive_channels[target];
        let main_arrival = input_edges[target]
            .iter()
            .filter_map(|edge| match edge {
                DiagnosticInputEdge::Main(source)
                    if !latency_sensitive || low_latency_plan.sensitive_channels[*source] =>
                {
                    Some(channel_latencies[*source])
                }
                DiagnosticInputEdge::Main(_) => None,
                DiagnosticInputEdge::Send(send) => native
                    .sends
                    .get(*send)
                    .filter(|_| !latency_sensitive)
                    .map(|send| channel_latencies[send.source_index as usize]),
                DiagnosticInputEdge::Sidechain { .. } => None,
            })
            .max()
            .unwrap_or(0);
        for edge in &input_edges[target] {
            match edge {
                DiagnosticInputEdge::Main(source) => {
                    channel_output_delays[*source] =
                        if latency_sensitive && low_latency_plan.sensitive_channels[*source] {
                            0
                        } else {
                            main_arrival.saturating_sub(channel_latencies[*source])
                        };
                }
                DiagnosticInputEdge::Send(send) => {
                    if let Some(source) = native.sends.get(*send) {
                        send_delays[*send] = main_arrival
                            .saturating_sub(channel_latencies[source.source_index as usize]);
                    }
                }
                DiagnosticInputEdge::Sidechain { .. } => {}
            }
        }
        let mut slot_arrival = main_arrival;
        let mut plugins = native
            .plugins
            .iter()
            .enumerate()
            .filter(|(_, plugin)| plugin.channel_index as usize == target)
            .collect::<Vec<_>>();
        plugins.sort_by_key(|(_, plugin)| {
            (
                if plugin.role == "instrument" { 0 } else { 1 },
                plugin.slot_order,
            )
        });
        for (plugin_index, plugin) in plugins {
            let convergence = if latency_sensitive {
                slot_arrival
            } else {
                plugin
                    .aux_input_buses
                    .iter()
                    .filter_map(|bus| bus.source_index)
                    .map(|source| channel_latencies[source as usize])
                    .fold(slot_arrival, u32::max)
            };
            main_slot_delays.insert(plugin_index, convergence.saturating_sub(slot_arrival));
            for bus in &plugin.aux_input_buses {
                if let Some(source) = bus.source_index {
                    sidechain_delays.insert(
                        (plugin_index, bus.input_bus_index),
                        convergence.saturating_sub(channel_latencies[source as usize]),
                    );
                }
            }
            let latency = if low_latency_bypassed.contains(&plugin.instance_id) {
                0
            } else {
                plugin.latency_samples
            };
            slot_arrival = convergence.saturating_add(latency);
        }
        channel_latencies[target] = slot_arrival;
    }

    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for (channel_index, channel) in native.channels.iter().enumerate() {
        let channel_id = channel.id.clone();
        let source_id = format!("source:{channel_id}");
        let mut width = if channel.input_channels.len() == 1 {
            CompiledGraphSignalWidth::Mono
        } else {
            CompiledGraphSignalWidth::Stereo
        };
        let source_kind = if channel.kind == "instrument" {
            CompiledGraphNodeKind::InstrumentInput
        } else if channel.input_source.as_deref() == Some("hardware") {
            CompiledGraphNodeKind::HardwareInput
        } else if channel.input_source.as_deref() == Some("bus") {
            CompiledGraphNodeKind::BusInput
        } else {
            CompiledGraphNodeKind::TimelineInput
        };
        nodes.push(CompiledGraphNode {
            id: source_id.clone(),
            kind: source_kind,
            label: match source_kind {
                CompiledGraphNodeKind::HardwareInput => "Hardware input",
                CompiledGraphNodeKind::BusInput => "BUS input",
                CompiledGraphNodeKind::InstrumentInput => "Instrument input",
                _ => "Timeline input",
            }
            .to_owned(),
            channel_id: Some(channel_id.clone()),
            plugin_instance_id: None,
            signal_width: width,
            latency_samples: 0,
            plugin_state: None,
            latency_sensitive: low_latency_plan.sensitive_channels[channel_index],
            low_latency_bypassed: false,
        });

        let mut previous = source_id;
        let mut plugins = native
            .plugins
            .iter()
            .enumerate()
            .filter(|(_, plugin)| plugin.channel_index as usize == channel_index)
            .collect::<Vec<_>>();
        plugins.sort_by_key(|(_, plugin)| {
            (
                if plugin.role == "instrument" { 0 } else { 1 },
                plugin.slot_order,
            )
        });
        for (plugin_index, plugin) in plugins {
            let main_delay = main_slot_delays.get(&plugin_index).copied().unwrap_or(0);
            if main_delay > 0 {
                let delay_id = format!("pdc:main:{}", plugin.instance_id);
                nodes.push(CompiledGraphNode {
                    id: delay_id.clone(),
                    kind: CompiledGraphNodeKind::PdcDelay,
                    label: "Main-input PDC".to_owned(),
                    channel_id: Some(channel_id.clone()),
                    plugin_instance_id: Some(plugin.instance_id.clone()),
                    signal_width: width,
                    latency_samples: main_delay,
                    plugin_state: None,
                    latency_sensitive: low_latency_plan.sensitive_channels[channel_index],
                    low_latency_bypassed: false,
                });
                edge(
                    &mut edges,
                    &previous,
                    &delay_id,
                    CompiledGraphEdgeKind::Signal,
                    width,
                );
                previous = delay_id;
            }
            let required = plugin_input_width(plugin.audio_mode);
            if required != width {
                let adapter_id = format!("adapter:{}:{}", plugin.instance_id, nodes.len());
                nodes.push(CompiledGraphNode {
                    id: adapter_id.clone(),
                    kind: CompiledGraphNodeKind::WidthAdapter,
                    label: if required == CompiledGraphSignalWidth::Mono {
                        "Stereo → Mono"
                    } else {
                        "Mono → Stereo"
                    }
                    .to_owned(),
                    channel_id: Some(channel_id.clone()),
                    plugin_instance_id: None,
                    signal_width: required,
                    latency_samples: 0,
                    plugin_state: None,
                    latency_sensitive: low_latency_plan.sensitive_channels[channel_index],
                    low_latency_bypassed: false,
                });
                edge(
                    &mut edges,
                    &previous,
                    &adapter_id,
                    CompiledGraphEdgeKind::Signal,
                    width,
                );
                previous = adapter_id;
                width = required;
            }

            let plugin_id = format!("effect:{}", plugin.instance_id);
            let plugin_state = if !plugin.enabled {
                CompiledGraphPluginState::Bypassed
            } else if plugin.processor.is_none() {
                CompiledGraphPluginState::Unavailable
            } else {
                CompiledGraphPluginState::Active
            };
            nodes.push(CompiledGraphNode {
                id: plugin_id.clone(),
                kind: CompiledGraphNodeKind::Effect,
                label: if plugin.role == "instrument" {
                    "Instrument"
                } else {
                    "Insert effect"
                }
                .to_owned(),
                channel_id: Some(channel_id.clone()),
                plugin_instance_id: Some(plugin.instance_id.clone()),
                signal_width: plugin_output_width(plugin.audio_mode),
                latency_samples: plugin.latency_samples,
                plugin_state: Some(plugin_state),
                latency_sensitive: low_latency_plan.sensitive_channels[channel_index],
                low_latency_bypassed: low_latency_bypassed.contains(&plugin.instance_id),
            });
            edge(
                &mut edges,
                &previous,
                &plugin_id,
                CompiledGraphEdgeKind::Signal,
                width,
            );
            previous = plugin_id;
            width = plugin_output_width(plugin.audio_mode);

            if plugin.latency_samples > 0 && !low_latency_bypassed.contains(&plugin.instance_id) {
                let delay_id = format!("delay:{}", plugin.instance_id);
                nodes.push(CompiledGraphNode {
                    id: delay_id.clone(),
                    kind: CompiledGraphNodeKind::PdcDelay,
                    label: if plugin_state == CompiledGraphPluginState::Bypassed {
                        "Bypass compensation"
                    } else {
                        "Plug-in latency"
                    }
                    .to_owned(),
                    channel_id: Some(channel_id.clone()),
                    plugin_instance_id: Some(plugin.instance_id.clone()),
                    signal_width: width,
                    latency_samples: plugin.latency_samples,
                    plugin_state: None,
                    latency_sensitive: low_latency_plan.sensitive_channels[channel_index],
                    low_latency_bypassed: low_latency_bypassed.contains(&plugin.instance_id),
                });
                edge(
                    &mut edges,
                    &previous,
                    &delay_id,
                    CompiledGraphEdgeKind::Signal,
                    width,
                );
                previous = delay_id;
            }
        }

        if width == CompiledGraphSignalWidth::Mono {
            let adapter_id = format!("adapter:{channel_id}:stereo-output");
            nodes.push(CompiledGraphNode {
                id: adapter_id.clone(),
                kind: CompiledGraphNodeKind::WidthAdapter,
                label: "Mono → Stereo".to_owned(),
                channel_id: Some(channel_id.clone()),
                plugin_instance_id: None,
                signal_width: CompiledGraphSignalWidth::Stereo,
                latency_samples: 0,
                plugin_state: None,
                latency_sensitive: low_latency_plan.sensitive_channels[channel_index],
                low_latency_bypassed: false,
            });
            edge(
                &mut edges,
                &previous,
                &adapter_id,
                CompiledGraphEdgeKind::Signal,
                width,
            );
            previous = adapter_id;
            width = CompiledGraphSignalWidth::Stereo;
        }

        let output_id = format!("channel:{channel_id}");
        let kind = match channel.kind.as_str() {
            "master" => CompiledGraphNodeKind::Master,
            "output" => CompiledGraphNodeKind::HardwareOutput,
            _ => CompiledGraphNodeKind::Channel,
        };
        nodes.push(CompiledGraphNode {
            id: output_id.clone(),
            kind,
            label: channel_id.clone(),
            channel_id: Some(channel_id),
            plugin_instance_id: None,
            signal_width: width,
            latency_samples: 0,
            plugin_state: None,
            latency_sensitive: low_latency_plan.sensitive_channels[channel_index],
            low_latency_bypassed: false,
        });
        edge(
            &mut edges,
            &previous,
            &output_id,
            CompiledGraphEdgeKind::Signal,
            width,
        );
    }

    for (channel_index, channel) in native.channels.iter().enumerate() {
        let channel_id = format!("channel:{}", channel.id);
        let route_source = if channel_output_delays[channel_index] > 0 {
            let delay_id = format!("pdc:channel:{}", channel.id);
            nodes.push(CompiledGraphNode {
                id: delay_id.clone(),
                kind: CompiledGraphNodeKind::PdcDelay,
                label: "Channel PDC".to_owned(),
                channel_id: Some(channel.id.clone()),
                plugin_instance_id: None,
                signal_width: CompiledGraphSignalWidth::Stereo,
                latency_samples: channel_output_delays[channel_index],
                plugin_state: None,
                latency_sensitive: low_latency_plan.sensitive_channels[channel_index],
                low_latency_bypassed: false,
            });
            edge(
                &mut edges,
                &channel_id,
                &delay_id,
                CompiledGraphEdgeKind::Signal,
                CompiledGraphSignalWidth::Stereo,
            );
            delay_id
        } else {
            channel_id
        };

        if let Some(target) = channel
            .output_index
            .and_then(|index| native.channels.get(index as usize))
        {
            edge(
                &mut edges,
                &route_source,
                &format!("channel:{}", target.id),
                if target.kind == "output" {
                    CompiledGraphEdgeKind::HardwareRoute
                } else {
                    CompiledGraphEdgeKind::MainRoute
                },
                CompiledGraphSignalWidth::Stereo,
            );
        } else if let Some(bus) = channel.output_bus {
            for target in native.channels.iter().filter(|target| {
                target.input_source.as_deref() == Some("bus")
                    && target.input_channels.contains(&bus)
            }) {
                edge(
                    &mut edges,
                    &route_source,
                    &format!("source:{}", target.id),
                    CompiledGraphEdgeKind::MainRoute,
                    CompiledGraphSignalWidth::Stereo,
                );
            }
        }
    }
    for (send_index, send) in native.sends.iter().enumerate() {
        let send_id = format!("send:{}", send.id);
        nodes.push(CompiledGraphNode {
            id: send_id.clone(),
            kind: CompiledGraphNodeKind::Send,
            label: format!("Send ({:?})", send.tap),
            channel_id: native
                .channels
                .get(send.source_index as usize)
                .map(|channel| channel.id.clone()),
            plugin_instance_id: None,
            signal_width: CompiledGraphSignalWidth::Stereo,
            latency_samples: 0,
            plugin_state: None,
            latency_sensitive: false,
            low_latency_bypassed: false,
        });
        if let Some(source) = native.channels.get(send.source_index as usize) {
            edge(
                &mut edges,
                &format!("channel:{}", source.id),
                &send_id,
                CompiledGraphEdgeKind::SendRoute,
                CompiledGraphSignalWidth::Stereo,
            );
        }
        let route_source = if send_delays[send_index] > 0 {
            let delay_id = format!("pdc:send:{}", send.id);
            nodes.push(CompiledGraphNode {
                id: delay_id.clone(),
                kind: CompiledGraphNodeKind::PdcDelay,
                label: "Send PDC".to_owned(),
                channel_id: native
                    .channels
                    .get(send.source_index as usize)
                    .map(|channel| channel.id.clone()),
                plugin_instance_id: None,
                signal_width: CompiledGraphSignalWidth::Stereo,
                latency_samples: send_delays[send_index],
                plugin_state: None,
                latency_sensitive: false,
                low_latency_bypassed: false,
            });
            edge(
                &mut edges,
                &send_id,
                &delay_id,
                CompiledGraphEdgeKind::Signal,
                CompiledGraphSignalWidth::Stereo,
            );
            delay_id
        } else {
            send_id
        };
        if let Some(target) = send
            .target_output_index
            .and_then(|index| native.channels.get(index as usize))
        {
            edge(
                &mut edges,
                &route_source,
                &format!("channel:{}", target.id),
                CompiledGraphEdgeKind::SendRoute,
                CompiledGraphSignalWidth::Stereo,
            );
        } else if let Some(bus) = send.target_bus {
            for target in native.channels.iter().filter(|target| {
                target.input_source.as_deref() == Some("bus")
                    && target.input_channels.contains(&bus)
            }) {
                edge(
                    &mut edges,
                    &route_source,
                    &format!("source:{}", target.id),
                    CompiledGraphEdgeKind::SendRoute,
                    CompiledGraphSignalWidth::Stereo,
                );
            }
        }
    }
    for (plugin_index, plugin) in native.plugins.iter().enumerate() {
        for bus in &plugin.aux_input_buses {
            let Some(source) = bus
                .source_index
                .and_then(|index| native.channels.get(index as usize))
            else {
                continue;
            };
            let delay = sidechain_delays
                .get(&(plugin_index, bus.input_bus_index))
                .copied()
                .unwrap_or(0);
            let route_source = if delay > 0 {
                let delay_id = format!(
                    "pdc:sidechain:{}:{}",
                    plugin.instance_id, bus.input_bus_index
                );
                nodes.push(CompiledGraphNode {
                    id: delay_id.clone(),
                    kind: CompiledGraphNodeKind::PdcDelay,
                    label: format!("Side-chain PDC · bus {}", bus.input_bus_index),
                    channel_id: Some(source.id.clone()),
                    plugin_instance_id: Some(plugin.instance_id.clone()),
                    signal_width: CompiledGraphSignalWidth::Stereo,
                    latency_samples: delay,
                    plugin_state: None,
                    latency_sensitive: false,
                    low_latency_bypassed: false,
                });
                edge(
                    &mut edges,
                    &format!("channel:{}", source.id),
                    &delay_id,
                    CompiledGraphEdgeKind::Signal,
                    CompiledGraphSignalWidth::Stereo,
                );
                delay_id
            } else {
                format!("channel:{}", source.id)
            };
            edges.push(CompiledGraphEdge {
                id: format!(
                    "{route_source}->effect:{}:{}",
                    plugin.instance_id,
                    edges.len()
                ),
                source: route_source,
                target: format!("effect:{}", plugin.instance_id),
                kind: CompiledGraphEdgeKind::SidechainRoute,
                signal_width: if bus.channels == 1 {
                    CompiledGraphSignalWidth::Mono
                } else {
                    CompiledGraphSignalWidth::Stereo
                },
                target_input_bus_index: Some(bus.input_bus_index),
            });
        }
    }

    CompiledAudioGraphSnapshot {
        graph_revision: native.generation,
        build_generation,
        sample_rate: native.sample_rate,
        low_latency_unavoidable_latency_samples: low_latency_plan.unavoidable_latency_samples,
        has_low_latency_monitoring_path: low_latency_plan.has_monitoring_path,
        nodes,
        edges,
    }
}
