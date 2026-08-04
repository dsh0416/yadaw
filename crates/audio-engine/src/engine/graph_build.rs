use super::*;

pub(super) fn build_mixer_runtime(
    native: NativeMixerGraph,
    build_generation: u64,
    transport: Arc<TransportShared>,
    input_peaks: Arc<InputPeakBank>,
) -> Result<NativeMixerRuntime> {
    if native.sample_rate == 0 {
        return Err(invalid_config("mixer sample rate must be positive"));
    }
    transport
        .sample_rate
        .store(native.sample_rate, Ordering::Relaxed);
    let low_latency_plan = match &native.latency_policy {
        NativeLatencyPolicy::Normal => LowLatencyPlan {
            sensitive_channels: vec![false; native.channels.len()],
            ..LowLatencyPlan::default()
        },
        NativeLatencyPolicy::LowLatency {
            target_output_index,
            plugin_budget_samples,
        } => plan_low_latency(
            &native
                .channels
                .iter()
                .map(|channel| LowLatencyChannel {
                    output: channel.output_index.map(|index| index as usize),
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
            &native
                .plugins
                .iter()
                .map(|plugin| LowLatencyPlugin {
                    instance_id: plugin.instance_id.clone(),
                    channel: plugin.channel_index as usize,
                    slot_order: plugin.slot_order,
                    latency_samples: plugin.latency_samples,
                    instrument: plugin.role == "instrument",
                })
                .collect::<Vec<_>>(),
            *target_output_index as usize,
            *plugin_budget_samples,
        ),
    };
    let low_latency_bypassed = low_latency_plan
        .bypassed_plugin_instance_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let input_meter_routes = native
        .channels
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
    let monitor_input_routes = native
        .channels
        .iter()
        .map(|channel| {
            if channel.kind != "audio"
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
    let channel_input_widths = native
        .channels
        .iter()
        .map(|channel| {
            if channel.kind != "instrument" && channel.input_channels.len() == 1 {
                SignalWidth::Mono
            } else {
                SignalWidth::Stereo
            }
        })
        .collect::<Vec<_>>();
    let live_midi_routes = native
        .channels
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
    let channels = native
        .channels
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
    let sends = native
        .sends
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
    let tempo_map = TempoMap::new(
        native.tempo_events.clone(),
        native.time_signature_events.clone(),
    )
    .map_err(|error| invalid_config(error.to_string()))?;
    let metronome_channel_index = native
        .channels
        .iter()
        .position(|channel| channel.system_role == Some(LiveMixerSystemRole::Metronome));
    let mut sidechain_edges = Vec::new();
    for plugin in &native.plugins {
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
                bus.input_bus_index,
            ));
        }
    }
    let dependencies = sidechain_edges
        .iter()
        .map(|(source, target, _, _)| (*source, *target))
        .collect::<Vec<_>>();
    let mut graph = MixerGraph::new_with_dependencies(
        native.sample_rate,
        channels.clone(),
        sends,
        &dependencies,
    )
    .map_err(|error| invalid_config(error.to_string()))?;
    let meter_bank = Arc::new(MeterBank {
        channels: native
            .channels
            .iter()
            .map(|channel| MeterAtomics::new(channel.id.clone()))
            .collect(),
    });
    let mut clips = Vec::with_capacity(native.clips.len());
    let mut content_end_frame = 0_u64;
    for clip in native.clips {
        let channel_index = clip.channel_index as usize;
        if channels
            .get(channel_index)
            .is_none_or(|channel| channel.kind != ChannelKind::Audio)
            || clip.start_frame < 0
            || clip.source_offset_frames < 0
            || clip.length_frames <= 0
            || clip.fade_in_frames < 0
            || clip.fade_out_frames < 0
            || clip.fade_in_frames.saturating_add(clip.fade_out_frames) > clip.length_frames
        {
            return Err(invalid_config("mixer clip has invalid placement"));
        }
        let start_frame = clip.start_frame as u64;
        let source_offset_frames = clip.source_offset_frames as usize;
        let file_size = fs::metadata(&clip.path)
            .map_err(|error| audio_error("failed to inspect mixer clip cache", error))?
            .len();
        let (samples, sample_frames) = match clip_storage_policy(file_size) {
            ClipStoragePolicy::Memory => {
                let decoded = decode_clip_audio(&clip.path, native.sample_rate)?;
                let sample_frames = decoded.len();
                (ClipSamples::Memory(decoded), sample_frames)
            }
            ClipStoragePolicy::Streaming => {
                let (streaming, sample_frames) =
                    spawn_streaming_clip(clip.path, native.sample_rate, source_offset_frames)?;
                (ClipSamples::Streaming(streaming), sample_frames)
            }
        };
        let available = sample_frames.saturating_sub(source_offset_frames);
        let length_frames = (clip.length_frames as usize).min(available);
        let fade_in_frames = (clip.fade_in_frames as usize).min(length_frames);
        let fade_out_frames =
            (clip.fade_out_frames as usize).min(length_frames.saturating_sub(fade_in_frames));
        content_end_frame = content_end_frame.max(start_frame.saturating_add(length_frames as u64));
        clips.push(LoadedClip {
            channel_index,
            start_frame,
            source_offset_frames,
            length_frames,
            fade_in_frames,
            fade_out_frames,
            samples,
        });
    }
    let mut plugins_by_channel = (0..channels.len())
        .map(|_| Vec::new())
        .collect::<Vec<Vec<LivePlugin>>>();
    let mut plugin_specs = native.plugins;
    plugin_specs.sort_by_key(|plugin| {
        (
            plugin.channel_index,
            if plugin.role == "instrument" { 0 } else { 1 },
            plugin.slot_order,
        )
    });
    let mut maximum_tail = 0_u64;
    let mut has_infinite_tail = false;
    for (marker_index, plugin) in plugin_specs.into_iter().enumerate() {
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
            marker_index,
            aux_inputs: plugin
                .aux_input_buses
                .into_iter()
                .filter_map(|bus| {
                    bus.source_index.map(|source_index| LivePluginAuxInput {
                        bus_index: bus.input_bus_index,
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
    for (send_index, send) in native.sends.iter().enumerate() {
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
                    .then_some(channel_latencies[native.sends[*send].source_index as usize]),
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
                    let source = native.sends[send].source_index as usize;
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
    let mut graph = RenderRuntime::from_mixer_graph(native.sample_rate, graph, render_tempo_map);
    graph.prepare_block_processing(MAX_PLUGIN_BLOCK_FRAMES);

    let mut midi_events = Vec::new();
    let mut next_note_id = 1_i32;
    let mut midi_event_data = Vec::new();
    for clip in native.midi_clips {
        let channel_index = clip.channel_index as usize;
        if channels
            .get(channel_index)
            .is_none_or(|channel| channel.kind != ChannelKind::Instrument)
        {
            return Err(invalid_config(
                "MIDI clip references a non-instrument track",
            ));
        }
        let clip_source_end = clip.source_offset_ticks.saturating_add(clip.length_ticks);
        for note in clip.notes {
            let note_source_end = note.start_tick.saturating_add(note.duration_ticks);
            if note_source_end <= clip.source_offset_ticks || note.start_tick >= clip_source_end {
                continue;
            }
            let clipped_start = note.start_tick.max(clip.source_offset_ticks);
            let clipped_end = note_source_end.min(clip_source_end);
            let project_start = clip
                .start_tick
                .saturating_add(clipped_start - clip.source_offset_ticks);
            let project_end = clip
                .start_tick
                .saturating_add(clipped_end - clip.source_offset_ticks);
            let start_frame = tempo_map
                .tick_to_frame(project_start, native.sample_rate)
                .map_err(|error| invalid_config(error.to_string()))?;
            let end_frame = tempo_map
                .tick_to_frame(project_end, native.sample_rate)
                .map_err(|error| invalid_config(error.to_string()))?;
            content_end_frame = content_end_frame.max(end_frame);
            midi_events.push(ScheduledMidiEvent {
                frame: start_frame,
                channel_index,
                channel: note.channel,
                kind: ScheduledMidiEventKind::NoteOn {
                    note_id: next_note_id,
                    key: note.key,
                    velocity: note.velocity,
                },
            });
            midi_events.push(ScheduledMidiEvent {
                frame: end_frame,
                channel_index,
                channel: note.channel,
                kind: ScheduledMidiEventKind::NoteOff {
                    note_id: next_note_id,
                    key: note.key,
                    velocity: note.release_velocity,
                },
            });
            next_note_id = next_note_id.saturating_add(1);
        }
        for event in clip.events {
            if event.tick < clip.source_offset_ticks || event.tick >= clip_source_end {
                continue;
            }
            let project_tick = clip
                .start_tick
                .saturating_add(event.tick - clip.source_offset_ticks);
            let frame = tempo_map
                .tick_to_frame(project_tick, native.sample_rate)
                .map_err(|error| invalid_config(error.to_string()))?;
            content_end_frame = content_end_frame.max(frame);
            let kind = match event.kind {
                NativeMidiEventKind::ControlChange { controller, value } => {
                    ScheduledMidiEventKind::ControlChange { controller, value }
                }
                NativeMidiEventKind::PitchBend { value } => {
                    ScheduledMidiEventKind::PitchBend { value }
                }
                NativeMidiEventKind::ProgramChange { program } => {
                    ScheduledMidiEventKind::ProgramChange { program }
                }
                NativeMidiEventKind::ChannelPressure { pressure } => {
                    ScheduledMidiEventKind::ChannelPressure { pressure }
                }
                NativeMidiEventKind::PolyPressure { key, pressure } => {
                    ScheduledMidiEventKind::PolyPressure { key, pressure }
                }
                NativeMidiEventKind::SysEx { data } => {
                    let offset = u32::try_from(midi_event_data.len())
                        .map_err(|_| invalid_config("MIDI event data exceeds 4 GiB"))?;
                    let length = u32::try_from(data.len())
                        .map_err(|_| invalid_config("SysEx event exceeds 4 GiB"))?;
                    midi_event_data.extend_from_slice(&data);
                    ScheduledMidiEventKind::SysEx { offset, length }
                }
            };
            midi_events.push(ScheduledMidiEvent {
                frame,
                channel_index,
                channel: event.channel,
                kind,
            });
        }
    }
    midi_events.sort_by_key(|event| (event.frame, event.kind.sort_rank()));
    let tail_end_frame =
        (!has_infinite_tail).then_some(content_end_frame.saturating_add(maximum_tail));
    let active_notes = vec![false; next_note_id as usize];
    let metronome = MetronomeScheduler::new(
        metronome_channel_index,
        &tempo_map,
        native.sample_rate,
        transport.position_frames.load(Ordering::Relaxed),
    );
    Ok(NativeMixerRuntime {
        generation: native.generation,
        build_generation,
        peak_scratch: vec![
            RenderMeter {
                pre: [0.0; 2],
                post: [0.0; 2],
            };
            graph.channel_count()
        ],
        held_peaks: vec![[0.0, 0.0]; graph.channel_count()],
        held_until: vec![[0, 0]; graph.channel_count()],
        channel_source_block: vec![
            [0.0, 0.0];
            channels.len().saturating_mul(MAX_PLUGIN_BLOCK_FRAMES)
        ],
        channel_input_widths,
        plugins_by_channel,
        midi_events,
        midi_event_data,
        midi_cursor: 0,
        active_notes,
        live_midi_routes,
        live_midi_events: Vec::with_capacity(
            heron_dsp_runtime::midi_input::MIDI_SHORT_QUEUE_CAPACITY,
        ),
        live_notes: vec![false; channels.len().saturating_mul(16 * 128)],
        external_sync_enabled: false,
        live_sysex_scratch: vec![0; heron_dsp_runtime::midi_input::MIDI_MAX_SYSEX_BYTES],
        metronome,
        count_in: None,
        tempo_map,
        graph,
        clips,
        meter_bank,
        transport,
        sample_rate: native.sample_rate,
        content_end_frame,
        tail_end_frame,
        has_infinite_tail,
        input_peaks,
        input_meter_routes,
        monitor_input_routes,
        input_peak_scratch: [0.0; MAX_INPUT_CHANNELS],
        meter_frame_clock: 0,
    })
}
