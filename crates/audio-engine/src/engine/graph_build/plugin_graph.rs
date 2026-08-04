use super::{
    ChannelKind, ChannelSpec, LivePlugin, LivePluginAuxInput, LowLatencyPlan,
    MAX_PLUGIN_BLOCK_FRAMES, MixerGraph, NativeMixerSend, NativePluginInstance, RenderRuntime,
    Result, RouteTarget, SendSpec, StereoDelayLine, TempoMap, invalid_config,
};

pub(super) struct PluginGraphBuild {
    pub(super) graph: RenderRuntime,
    pub(super) plugins_by_channel: Vec<Vec<LivePlugin>>,
    pub(super) maximum_tail: u64,
    pub(super) has_infinite_tail: bool,
}

pub(super) struct PluginGraphInput<'a> {
    pub(super) sample_rate: u32,
    pub(super) native_plugins: Vec<NativePluginInstance>,
    pub(super) native_sends: &'a [NativeMixerSend],
    pub(super) channels: &'a [ChannelSpec],
    pub(super) sends: Vec<SendSpec>,
    pub(super) low_latency_plan: &'a LowLatencyPlan,
    pub(super) low_latency_bypassed: &'a std::collections::HashSet<String>,
    pub(super) tempo_map: &'a TempoMap,
}

pub(super) fn build_plugin_graph(input: PluginGraphInput<'_>) -> Result<PluginGraphBuild> {
    let PluginGraphInput {
        sample_rate,
        native_plugins,
        native_sends,
        channels,
        sends,
        low_latency_plan,
        low_latency_bypassed,
        tempo_map,
    } = input;
    let mut sidechain_edges = Vec::new();
    for plugin in &native_plugins {
        let target = plugin.channel_index as usize;
        for bus in &plugin.aux_input_buses {
            let Some(source) = bus.source_index.map(|index| index as usize) else {
                continue;
            };
            if target >= channels.len()
                || source >= channels.len()
                || source == target
                || (bus.channels != 1 && bus.channels != 2)
            {
                return Err(invalid_config("plugin side-chain route is invalid"));
            }
            sidechain_edges.push((
                source,
                target,
                plugin.instance_id.clone(),
                bus.input_port_key.clone(),
            ));
        }
    }
    let dependencies = sidechain_edges
        .iter()
        .map(|(source, target, _, _)| (*source, *target))
        .collect::<Vec<_>>();
    let mut graph =
        MixerGraph::new_with_dependencies(sample_rate, channels.to_vec(), sends, &dependencies)
            .map_err(|error| invalid_config(error.to_string()))?;
    let mut plugins_by_channel = (0..channels.len())
        .map(|_| Vec::new())
        .collect::<Vec<Vec<LivePlugin>>>();
    let mut plugin_specs = native_plugins;
    plugin_specs.sort_by_key(|plugin| {
        (
            plugin.channel_index,
            if plugin.role == "instrument" { 0 } else { 1 },
            plugin.slot_order,
        )
    });
    let mut maximum_tail = 0_u64;
    let mut has_infinite_tail = false;
    for plugin in plugin_specs {
        let channel_index = plugin.channel_index as usize;
        if channel_index >= channels.len() {
            return Err(invalid_config("plugin references an invalid mixer channel"));
        }
        let is_instrument = plugin.role == "instrument";
        if is_instrument && channels[channel_index].kind != ChannelKind::Instrument {
            return Err(invalid_config(
                "instrument plugin is assigned to a non-instrument track",
            ));
        }
        match plugin.tail_samples {
            Some(tail) => maximum_tail = maximum_tail.saturating_add(u64::from(tail)),
            None => has_infinite_tail = true,
        }
        let is_low_latency_bypassed = low_latency_bypassed.contains(&plugin.instance_id);
        plugins_by_channel[channel_index].push(LivePlugin {
            instance_id: plugin.instance_id,
            processor: plugin.processor,
            audio_mode: plugin.audio_mode,
            enabled: plugin.enabled,
            is_instrument,
            latency_samples: plugin.latency_samples,
            low_latency_bypassed: is_low_latency_bypassed,
            main_delay: StereoDelayLine::new(0),
            bypass_delay: StereoDelayLine::new(plugin.latency_samples as usize),
            aux_inputs: plugin
                .aux_input_buses
                .into_iter()
                .filter_map(|bus| {
                    bus.source_index.map(|source_index| LivePluginAuxInput {
                        port_token: bus.input_port_token,
                        channels: bus.channels,
                        source_index: source_index as usize,
                        delay: StereoDelayLine::new(0),
                        block: vec![[0.0, 0.0]; MAX_PLUGIN_BLOCK_FRAMES],
                    })
                })
                .collect(),
        });
    }

    enum InputEdge {
        Main(usize),
        Send(usize),
    }
    let mut input_edges = (0..channels.len())
        .map(|_| Vec::new())
        .collect::<Vec<Vec<InputEdge>>>();
    for (source, channel) in channels.iter().enumerate() {
        match channel.output {
            Some(RouteTarget::Output(target)) => {
                input_edges[target].push(InputEdge::Main(source));
            }
            Some(RouteTarget::Bus(bus)) => {
                for (target, consumer) in channels.iter().enumerate() {
                    if consumer
                        .input_bus
                        .is_some_and(|inputs| inputs.contains(&bus))
                    {
                        input_edges[target].push(InputEdge::Main(source));
                    }
                }
            }
            None => {}
        }
    }
    for (send_index, send) in native_sends.iter().enumerate() {
        if send.enabled {
            match (send.target_output_index, send.target_bus) {
                (Some(target), None) => {
                    input_edges[target as usize].push(InputEdge::Send(send_index));
                }
                (None, Some(bus)) => {
                    let bus = bus.saturating_sub(1) as usize;
                    for (target, channel) in channels.iter().enumerate() {
                        if channel
                            .input_bus
                            .is_some_and(|inputs| inputs.contains(&bus))
                        {
                            input_edges[target].push(InputEdge::Send(send_index));
                        }
                    }
                }
                _ => unreachable!("validated send target must be exclusive"),
            }
        }
    }
    // Resolve PDC at each plug-in slot. A side-chain source is the source
    // channel's final post-pan signal, while the main path has only accumulated
    // latency up to the target slot. Both are delayed to the same convergence
    // point before the processor runs.
    let mut channel_latencies = vec![0_u32; channels.len()];
    let processing_order = graph.processing_order().to_vec();
    for target in processing_order {
        let latency_sensitive = low_latency_plan.sensitive_channels[target];
        let main_arrival = input_edges[target]
            .iter()
            .filter_map(|edge| match edge {
                InputEdge::Main(source)
                    if !latency_sensitive || low_latency_plan.sensitive_channels[*source] =>
                {
                    Some(channel_latencies[*source])
                }
                InputEdge::Send(send) => (!latency_sensitive)
                    .then_some(channel_latencies[native_sends[*send].source_index as usize]),
                InputEdge::Main(_) => None,
            })
            .max()
            .unwrap_or(0);
        for edge in &input_edges[target] {
            match *edge {
                InputEdge::Main(source) => {
                    let delay = if latency_sensitive && low_latency_plan.sensitive_channels[source]
                    {
                        0
                    } else {
                        main_arrival.saturating_sub(channel_latencies[source]) as usize
                    };
                    graph
                        .set_channel_output_delay(source, delay)
                        .map_err(|error| invalid_config(error.to_string()))?;
                }
                InputEdge::Send(send) => {
                    let source = native_sends[send].source_index as usize;
                    let delay = main_arrival.saturating_sub(channel_latencies[source]) as usize;
                    graph
                        .set_send_delay(send, delay)
                        .map_err(|error| invalid_config(error.to_string()))?;
                }
            }
        }
        let mut slot_arrival = main_arrival;
        for plugin in &mut plugins_by_channel[target] {
            let convergence = if latency_sensitive {
                slot_arrival
            } else {
                plugin
                    .aux_inputs
                    .iter()
                    .map(|input| channel_latencies[input.source_index])
                    .fold(slot_arrival, u32::max)
            };
            plugin.main_delay =
                StereoDelayLine::new(convergence.saturating_sub(slot_arrival) as usize);
            for input in &mut plugin.aux_inputs {
                input.delay = StereoDelayLine::new(
                    convergence.saturating_sub(channel_latencies[input.source_index]) as usize,
                );
            }
            let effective_latency = if plugin.low_latency_bypassed {
                0
            } else {
                plugin.latency_samples
            };
            slot_arrival = convergence
                .checked_add(effective_latency)
                .ok_or_else(|| invalid_config("plugin latency exceeds the supported range"))?;
        }
        channel_latencies[target] = slot_arrival;
    }
    let render_tempo_map = TempoMap::new(
        tempo_map.tempo_events().to_vec(),
        tempo_map.time_signature_events().to_vec(),
    )
    .map_err(|error| invalid_config(error.to_string()))?;
    let mut graph = RenderRuntime::from_mixer_graph(sample_rate, graph, render_tempo_map);
    graph.prepare_block_processing(MAX_PLUGIN_BLOCK_FRAMES);
    Ok(PluginGraphBuild {
        graph,
        plugins_by_channel,
        maximum_tail,
        has_infinite_tail,
    })
}
