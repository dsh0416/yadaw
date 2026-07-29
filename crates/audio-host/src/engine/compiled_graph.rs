fn compiled_graph_snapshot(
    native: &NativeMixerGraph,
    build_generation: u64,
) -> CompiledAudioGraphSnapshot {
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
    }

    let intrinsic_latencies = native
        .channels
        .iter()
        .enumerate()
        .map(|(channel_index, _)| {
            native
                .plugins
                .iter()
                .filter(|plugin| plugin.channel_index as usize == channel_index)
                .fold(0_u32, |latency, plugin| {
                    latency.saturating_add(plugin.latency_samples)
                })
        })
        .collect::<Vec<_>>();
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
    let latency_nodes = input_edges
        .iter()
        .enumerate()
        .map(|(index, edges)| LatencyNode {
            id: native.channels[index].id.clone(),
            intrinsic_latency: intrinsic_latencies[index],
            inputs: edges
                .iter()
                .filter_map(|edge| match edge {
                    DiagnosticInputEdge::Main(source) => Some(*source),
                    DiagnosticInputEdge::Send(send) => native
                        .sends
                        .get(*send)
                        .map(|send| send.source_index as usize),
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    let latency_plan = plan_latency_compensation(&latency_nodes).ok();
    let mut channel_output_delays = vec![0_u32; native.channels.len()];
    let mut send_delays = vec![0_u32; native.sends.len()];
    if let Some(latency_plan) = latency_plan {
        for (target, edges) in input_edges.iter().enumerate() {
            for (input, edge) in edges.iter().enumerate() {
                let delay = latency_plan[target].input_delays[input];
                match edge {
                    DiagnosticInputEdge::Main(source) => {
                        channel_output_delays[*source] = channel_output_delays[*source].max(delay);
                    }
                    DiagnosticInputEdge::Send(send) => {
                        send_delays[*send] = send_delays[*send].max(delay);
                    }
                }
            }
        }
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
        });

        let mut previous = source_id;
        let mut plugins = native
            .plugins
            .iter()
            .filter(|plugin| plugin.channel_index as usize == channel_index)
            .collect::<Vec<_>>();
        plugins.sort_by_key(|plugin| (plugin.role.as_str(), plugin.slot_order));
        for plugin in plugins {
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

            if plugin.latency_samples > 0 {
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

    CompiledAudioGraphSnapshot {
        graph_revision: native.generation,
        build_generation,
        sample_rate: native.sample_rate,
        nodes,
        edges,
    }
}
