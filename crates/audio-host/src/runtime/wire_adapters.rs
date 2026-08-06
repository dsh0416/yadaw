use super::{
    ApplicationCaptureLogicalTarget, ApplicationCaptureSnapshot,
    ApplicationCaptureTargetDescriptor, AudioBackend, AudioDevice, AudioDeviceList, AudioRuntime,
    BinaryPayload, ControlCommand, ControlResult, GraphUpdate, HashMap, LiveLatencyPolicy,
    LiveMixerGraph, MIDI_INPUT, MidiNoteBatch, MixerChannelMeter, NativeRecordingResult,
    NativeRecordingStartConfig, NativeWaveformSnapshot, RecordingResult, RecordingWaveform,
    RoundTripLatencyMeasurement, TempoEvent, TimeSignatureEvent, TransportState, device, engine,
    vst3,
};

fn audio_runtime(value: engine::NativeAudioRuntimeSnapshot) -> AudioRuntime {
    AudioRuntime {
        state: value.state,
        requested_buffer_size: value.requested_buffer_size,
        sample_rate: value.sample_rate,
        input_sample_rate: value.input_sample_rate,
        output_sample_rate: value.output_sample_rate,
        input_buffer_size: value.input_buffer_size,
        output_buffer_size: value.output_buffer_size,
        ring_buffer_capacity_frames: value.ring_buffer_capacity_frames,
        ring_buffer_fill_frames: value.ring_buffer_fill_frames,
        input_latency_ms: value.input_latency_ms,
        output_latency_ms: value.output_latency_ms,
        ring_buffer_latency_ms: value.ring_buffer_latency_ms,
        engine_latency_ms: value.engine_latency_ms,
        estimated_round_trip_latency_ms: value.estimated_round_trip_latency_ms,
        xruns: value.xruns,
        clock_sync: value.clock_sync,
        buffer_fallback: value.buffer_fallback,
    }
}

fn round_trip_latency_measurement(
    value: engine::NativeRoundTripLatencyMeasurementSnapshot,
) -> RoundTripLatencyMeasurement {
    RoundTripLatencyMeasurement {
        status: value.status,
        input_channel: value.input_channel,
        output_channel: value.output_channel,
        measured_round_trip_latency_ms: value.measured_round_trip_latency_ms,
        failure: value.failure,
    }
}

fn application_target(
    value: engine::application_capture::ApplicationCaptureTargetDescriptor,
) -> ApplicationCaptureTargetDescriptor {
    ApplicationCaptureTargetDescriptor {
        runtime_id: value.runtime_id,
        process_id: value.process_id,
        display_name: value.display_name,
        executable_path: value.executable_path,
        logical_target: ApplicationCaptureLogicalTarget {
            platform: value.logical_target.platform,
            executable_path: value.logical_target.executable_path,
            executable_name: value.logical_target.executable_name,
            include_process_tree: value.logical_target.include_process_tree,
        },
        channel_count: value.channel_count,
        status: value.status,
    }
}

fn application_snapshot(
    value: engine::application_capture::ApplicationCaptureSnapshot,
) -> ApplicationCaptureSnapshot {
    ApplicationCaptureSnapshot {
        runtime_id: value.runtime_id,
        process_id: value.process_id,
        display_name: value.display_name,
        executable_path: value.executable_path,
        logical_target: ApplicationCaptureLogicalTarget {
            platform: value.logical_target.platform,
            executable_path: value.logical_target.executable_path,
            executable_name: value.logical_target.executable_name,
            include_process_tree: value.logical_target.include_process_tree,
        },
        channel_count: value.channel_count,
        status: value.status,
        dropout_frames: value.dropout_frames,
        overflow_frames: value.overflow_frames,
        underflow_frames: value.underflow_frames,
    }
}

pub(super) fn live_graph(
    generation: u64,
    value: &LiveMixerGraph,
    processors: Option<&HashMap<String, vst3::AudioPluginProcessorHandle>>,
) -> Result<engine::NativeMixerGraph, String> {
    let channel_indexes = value
        .channels
        .iter()
        .enumerate()
        .map(|(index, channel)| (channel.id.clone(), index as u32))
        .collect::<HashMap<_, _>>();
    let channel_index = |id: &str| {
        channel_indexes
            .get(id)
            .copied()
            .ok_or_else(|| format!("mixer graph references missing channel `{id}`"))
    };
    let channels = value
        .channels
        .iter()
        .map(|channel| {
            if channel.input_source.as_deref() == Some("application")
                && channel.application_capture.is_none()
            {
                return Err(format!(
                    "application input channel `{}` is missing its logical capture target",
                    channel.id
                ));
            }
            if channel.input_source.as_deref() == Some("application")
                && (channel.input_channels.is_empty() || channel.input_channels.len() > 2)
            {
                return Err(format!(
                    "application input channel `{}` must be mono or stereo",
                    channel.id
                ));
            }
            Ok(engine::NativeMixerChannel {
                id: channel.id.clone(),
                name: channel.name.clone(),
                color: channel.color.clone(),
                kind: channel.kind.clone(),
                system_role: channel.system_role,
                gain_db: channel.gain_db,
                pan: channel.pan,
                muted: channel.muted,
                soloed: channel.soloed,
                output_index: channel
                    .output_channel_id
                    .as_deref()
                    .map(channel_index)
                    .transpose()?,
                output_bus: channel.output_bus,
                record_armed: channel.record_armed,
                input_monitoring: channel.input_monitoring,
                input_source: channel.input_source.clone(),
                input_channels: channel.input_channels.clone(),
                application_capture: channel.application_capture.as_ref().map(|target| {
                    engine::NativeApplicationCaptureTarget {
                        platform: target.platform.clone(),
                        executable_path: target.executable_path.clone(),
                        executable_name: target.executable_name.clone(),
                        include_process_tree: target.include_process_tree,
                    }
                }),
                hardware_output_channels: channel.hardware_output_channels.clone(),
                midi_input_port_id: channel.midi_input_port_id.clone(),
                midi_input_channel: channel.midi_input_channel,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let sends = value
        .sends
        .iter()
        .map(|send| {
            Ok(engine::NativeMixerSend {
                id: send.id.clone(),
                source_index: channel_index(&send.source_channel_id)?,
                target_output_index: send
                    .target_channel_id
                    .as_deref()
                    .map(channel_index)
                    .transpose()?,
                target_bus: send.target_bus,
                enabled: send.enabled,
                tap: send.tap,
                level_db: send.level_db,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let clips = value
        .clips
        .iter()
        .map(|clip| {
            Ok(engine::NativeMixerClip {
                id: clip.id.clone(),
                channel_index: channel_index(&clip.channel_id)?,
                start_frame: clip.start_frame,
                source_offset_frames: clip.source_offset_frames,
                length_frames: clip.length_frames,
                fade_in_frames: clip.fade_in_frames,
                fade_out_frames: clip.fade_out_frames,
                path: clip.path.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let plugins = value
        .plugins
        .iter()
        .map(|plugin| {
            Ok(engine::NativePluginInstance {
                processor: processors
                    .and_then(|processors| processors.get(&plugin.instance_id))
                    .cloned(),
                instance_id: plugin.instance_id.clone(),
                channel_index: channel_index(&plugin.channel_id)?,
                role: plugin.role.clone(),
                slot_order: plugin.slot_order,
                audio_mode: plugin.audio_mode,
                enabled: plugin.enabled,
                aux_input_buses: plugin
                    .aux_input_buses
                    .iter()
                    .map(|bus| {
                        Ok(engine::NativePluginAuxInputBus {
                            input_port_key: bus.input_port_key.clone(),
                            input_port_token: bus
                                .input_port_key
                                .rsplit(':')
                                .next()
                                .and_then(|value| value.parse().ok())
                                .ok_or_else(|| {
                                    format!(
                                        "plug-in input port key '{}' has no numeric runtime token",
                                        bus.input_port_key
                                    )
                                })?,
                            name: bus.name.clone(),
                            channels: bus.channels,
                            source_index: bus
                                .source_channel_id
                                .as_deref()
                                .map(channel_index)
                                .transpose()?,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?,
                latency_samples: plugin.latency_samples,
                tail_samples: plugin.tail_samples,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let midi_clips = value
        .midi_clips
        .iter()
        .map(|clip| {
            let native_notes = match &clip.notes {
                MidiNoteBatch::Inline { notes } => {
                    let mut native_notes = Vec::with_capacity(notes.len());
                    native_notes.extend(notes.iter().map(|note| engine::NativeMidiNote {
                        start_tick: note.start_tick,
                        duration_ticks: note.duration_ticks,
                        channel: note.channel,
                        key: note.key,
                        velocity: note.velocity,
                        release_velocity: note.release_velocity,
                    }));
                    native_notes
                }
                MidiNoteBatch::Shared { .. } => {
                    return Err("mixer graph contains a removed shared-memory MIDI batch".into());
                }
            };
            let heron_dsp_runtime::protocol::MidiEventBatch::Inline { events } = &clip.events
            else {
                return Err("MIDI event batch must be materialized before graph build".to_owned());
            };
            let mut native_events = Vec::with_capacity(events.len());
            for event in events {
                let channel = event.channel.unwrap_or(0);
                if channel > 15 {
                    return Err("MIDI event channel must be in 0..15".to_owned());
                }
                let data = event
                    .data
                    .as_inline()
                    .ok_or_else(|| "MIDI event payload must be materialized".to_owned())?;
                let kind = match event.kind.as_str() {
                    "control-change" if data.len() == 2 && data[0] <= 127 && data[1] <= 127 => {
                        engine::NativeMidiEventKind::ControlChange {
                            controller: data[0],
                            value: data[1],
                        }
                    }
                    "pitch-bend" if data.len() == 2 => {
                        let value = u16::from_le_bytes([data[0], data[1]]);
                        if value > 16_383 {
                            return Err("MIDI pitch bend must be in 0..16383".to_owned());
                        }
                        engine::NativeMidiEventKind::PitchBend { value }
                    }
                    "program-change" if data.len() == 1 && data[0] <= 127 => {
                        engine::NativeMidiEventKind::ProgramChange { program: data[0] }
                    }
                    "channel-pressure" if data.len() == 1 && data[0] <= 127 => {
                        engine::NativeMidiEventKind::ChannelPressure { pressure: data[0] }
                    }
                    "poly-pressure" if data.len() == 2 && data[0] <= 127 && data[1] <= 127 => {
                        engine::NativeMidiEventKind::PolyPressure {
                            key: data[0],
                            pressure: data[1],
                        }
                    }
                    "sysex" if event.channel.is_none() && data.len() <= 1024 * 1024 => {
                        engine::NativeMidiEventKind::SysEx {
                            data: data.to_vec(),
                        }
                    }
                    _ => return Err(format!("invalid MIDI event {}", event.kind)),
                };
                if !matches!(kind, engine::NativeMidiEventKind::SysEx { .. })
                    && event.channel.is_none()
                {
                    return Err(format!("MIDI event {} requires a channel", event.kind));
                }
                native_events.push(engine::NativeMidiEvent {
                    tick: event.tick,
                    channel,
                    kind,
                });
            }
            Ok(engine::NativeMidiClip {
                id: clip.id.clone(),
                channel_index: channel_index(&clip.channel_id)?,
                start_tick: clip.start_tick,
                source_offset_ticks: clip.source_offset_ticks,
                length_ticks: clip.length_ticks,
                notes: native_notes,
                events: native_events,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(engine::NativeMixerGraph {
        generation,
        sample_rate: value.sample_rate,
        project_end_tick: value.project_end_tick,
        latency_policy: match &value.latency_policy {
            LiveLatencyPolicy::Normal => engine::NativeLatencyPolicy::Normal,
            LiveLatencyPolicy::LowLatency {
                target_output_channel_id,
                plugin_budget_samples,
            } => engine::NativeLatencyPolicy::LowLatency {
                target_output_index: channel_index(target_output_channel_id)?,
                plugin_budget_samples: *plugin_budget_samples,
            },
        },
        channels,
        sends,
        clips,
        plugins,
        midi_clips,
        tempo_events: value
            .tempo_events
            .iter()
            .map(|event| TempoEvent {
                tick: event.tick,
                beats_per_minute: event.beats_per_minute,
            })
            .collect(),
        time_signature_events: value
            .time_signature_events
            .iter()
            .map(|event| TimeSignatureEvent {
                tick: event.tick,
                numerator: event.numerator,
                denominator: event.denominator,
            })
            .collect(),
    })
}

fn recording_result(value: NativeRecordingResult) -> RecordingResult {
    RecordingResult {
        path: value.path,
        sample_rate: value.sample_rate,
        channels: value.channels,
        frame_count: value.frame_count,
        dropout_frames: value.dropout_frames,
    }
}

fn recording_waveform(value: NativeWaveformSnapshot) -> RecordingWaveform {
    RecordingWaveform {
        sample_rate: value.sample_rate,
        channels: value.channels,
        frame_count: value.frame_count,
        start_frame: value.start_frame,
        end_frame: value.end_frame,
        frames_per_bucket: value.frames_per_bucket,
        bucket_count: value.bucket_count,
        peaks: BinaryPayload::inline(value.peaks),
    }
}

pub(super) fn engine_command(
    audio_engine: &engine::AudioEngine,
    command: ControlCommand,
    processors: Option<&HashMap<String, vst3::AudioPluginProcessorHandle>>,
) -> Option<ControlResult> {
    let result = match command {
        ControlCommand::ListAudioBackends => ControlResult::AudioBackends {
            backends: device::list_audio_backends()
                .into_iter()
                .map(|backend| AudioBackend {
                    id: backend.id,
                    label: backend.label,
                    available: backend.available,
                })
                .collect(),
        },
        ControlCommand::ListAudioDevices { backend } => {
            let value = match device::list_audio_devices(backend) {
                Ok(value) => value,
                Err(error) => {
                    return Some(control_error! {
                        message: error.to_string(),
                    });
                }
            };
            let convert = |device: device::NativeAudioDevice| AudioDevice {
                id: device.id,
                name: device.name,
                is_default: device.is_default,
                default_sample_rate: device.default_sample_rate,
                min_buffer_size: device.min_buffer_size,
                max_buffer_size: device.max_buffer_size,
                channel_count: device.channel_count,
            };
            ControlResult::AudioDevices {
                devices: AudioDeviceList {
                    inputs: value.inputs.into_iter().map(convert).collect(),
                    outputs: value.outputs.into_iter().map(convert).collect(),
                },
            }
        }
        ControlCommand::ListApplicationCaptureTargets => ControlResult::ApplicationCaptureTargets {
            targets: audio_engine
                .list_application_capture_targets()
                .into_iter()
                .map(application_target)
                .collect(),
        },
        ControlCommand::ApplicationCaptureSnapshot => ControlResult::ApplicationCaptures {
            captures: audio_engine
                .application_capture_snapshot()
                .into_iter()
                .map(application_snapshot)
                .collect(),
        },
        ControlCommand::StartAudioEngine { config } => {
            match audio_engine.start_audio_engine(engine::NativeAudioEngineConfig {
                backend: config.backend,
                input_device_id: config.input_device_id,
                output_device_id: config.output_device_id,
                buffer_size: config.buffer_size,
                session_sample_rate: config.session_sample_rate,
            }) {
                Ok(runtime) => ControlResult::AudioRuntime {
                    runtime: audio_runtime(runtime),
                },
                Err(error) => control_error! {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::StopAudioEngine => match audio_engine.stop_audio_engine() {
            Ok(runtime) => ControlResult::AudioRuntime {
                runtime: audio_runtime(runtime),
            },
            Err(error) => control_error! {
                message: error.to_string(),
            },
        },
        ControlCommand::AudioEngineSnapshot => match audio_engine.audio_engine_snapshot() {
            Ok(runtime) => ControlResult::AudioRuntime {
                runtime: audio_runtime(runtime),
            },
            Err(error) => control_error! {
                message: error.to_string(),
            },
        },
        ControlCommand::StartRoundTripLatencyMeasurement { request } => {
            match audio_engine.start_round_trip_latency_measurement(
                engine::NativeRoundTripLatencyMeasurementRequest {
                    input_channel: request.input_channel,
                    output_channel: request.output_channel,
                },
            ) {
                Ok(measurement) => ControlResult::RoundTripLatencyMeasurement {
                    measurement: round_trip_latency_measurement(measurement),
                },
                Err(error) => control_error! {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::RoundTripLatencyMeasurementSnapshot => {
            match audio_engine.round_trip_latency_measurement_snapshot() {
                Ok(measurement) => ControlResult::RoundTripLatencyMeasurement {
                    measurement: round_trip_latency_measurement(measurement),
                },
                Err(error) => control_error! {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::UpdateGraph {
            update: GraphUpdate::Replace { revision, graph },
        } => {
            match live_graph(revision, &graph, processors).and_then(|graph| {
                audio_engine
                    .load_mixer_graph(graph)
                    .map_err(|error| error.to_string())
            }) {
                Ok(()) => ControlResult::GraphAccepted { revision },
                Err(error) => control_error! { message: error },
            }
        }
        ControlCommand::UpdateGraph {
            update: GraphUpdate::Patch { .. },
        } => control_error! {
            message: "graph patches require the IPC protocol actor".into(),
        },
        ControlCommand::PreviewMixerParameter { preview } => {
            match audio_engine.preview_mixer_parameter(engine::NativeMixerParameterPreview {
                target: preview.target,
                id: preview.id,
                parameter: preview.parameter,
                value: preview.value,
            }) {
                Ok(()) => ControlResult::Accepted,
                Err(error) => control_error! {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::MixerSnapshot => match audio_engine.mixer_snapshot() {
            Ok(snapshot) => ControlResult::MixerSnapshot {
                meters: snapshot
                    .meters
                    .into_iter()
                    .map(|meter| MixerChannelMeter {
                        channel_id: meter.channel_id,
                        pre_left: meter.pre_left,
                        pre_right: meter.pre_right,
                        post_left: meter.post_left,
                        post_right: meter.post_right,
                        held_left: meter.held_left,
                        held_right: meter.held_right,
                        clipped: meter.clipped,
                    })
                    .collect(),
            },
            Err(error) => control_error! {
                message: error.to_string(),
            },
        },
        ControlCommand::CompiledGraphSnapshot => ControlResult::CompiledGraphSnapshot {
            snapshot: audio_engine.compiled_audio_graph_snapshot(),
        },
        ControlCommand::ClearMeterClips => {
            match audio_engine.transport_command(
                "clear-meter-clips".to_owned(),
                None,
                None,
                None,
                None,
            ) {
                Ok(_) => ControlResult::Accepted,
                Err(error) => control_error! {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::Transport { command } => {
            match audio_engine.transport_command(
                command.kind,
                command.position_frames,
                command.loop_enabled,
                command.loop_start_tick,
                command.loop_end_tick,
            ) {
                Ok(value) => ControlResult::TransportSnapshot {
                    transport: TransportState {
                        state: value.state,
                        position_frames: value.position_frames,
                        position_ticks: value.position_ticks,
                        sample_rate: value.sample_rate,
                        effective_bpm: value.effective_bpm,
                        clock_source: value.clock_source,
                        waiting_for: value.waiting_for,
                        loop_enabled: value.loop_enabled,
                        loop_start_tick: value.loop_start_tick,
                        loop_end_tick: value.loop_end_tick,
                    },
                },
                Err(error) => control_error! {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::TransportSnapshot => match audio_engine.transport_snapshot() {
            Ok(value) => ControlResult::TransportSnapshot {
                transport: TransportState {
                    state: value.state,
                    position_frames: value.position_frames,
                    position_ticks: value.position_ticks,
                    sample_rate: value.sample_rate,
                    effective_bpm: value.effective_bpm,
                    clock_source: value.clock_source,
                    waiting_for: value.waiting_for,
                    loop_enabled: value.loop_enabled,
                    loop_start_tick: value.loop_start_tick,
                    loop_end_tick: value.loop_end_tick,
                },
            },
            Err(error) => control_error! {
                message: error.to_string(),
            },
        },
        ControlCommand::MidiInputSnapshot => match MIDI_INPUT.get() {
            Some(actor) => ControlResult::MidiInputSnapshot {
                midi_input: actor.snapshot(),
            },
            None => control_error! {
                message: "MIDI input actor is unavailable".to_owned(),
            },
        },
        ControlCommand::ConfigureMidiInput { preferences } => {
            match MIDI_INPUT
                .get()
                .ok_or_else(|| "MIDI input actor is unavailable".to_owned())
                .and_then(|actor| actor.configure(preferences))
            {
                Ok(midi_input) => ControlResult::MidiInputSnapshot { midi_input },
                Err(message) => control_error! { message },
            }
        }
        ControlCommand::StartRecording { config } => {
            match audio_engine.start_recording(NativeRecordingStartConfig {
                path: config.path,
                asset_id: config.asset_id,
                originator: config.originator,
                origination_date: config.origination_date,
                origination_time: config.origination_time,
                time_reference: config.time_reference,
                sample_rate: config.sample_rate,
                channels: config.channels,
            }) {
                Ok(()) => ControlResult::Accepted,
                Err(error) => control_error! {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::StopRecording => match audio_engine.stop_recording() {
            Ok(value) => ControlResult::RecordingStopped {
                recording: recording_result(value),
            },
            Err(error) => control_error! {
                message: error.to_string(),
            },
        },
        ControlCommand::StartMidiRecording { config } => {
            match (|| {
                let clock = audio_engine
                    .transport_clock_handle()
                    .map_err(|error| error.to_string())?;
                let actor = MIDI_INPUT
                    .get()
                    .ok_or_else(|| "MIDI input actor is unavailable".to_owned())?;
                actor.start_recording(config, clock)
            })() {
                Ok(()) => ControlResult::Accepted,
                Err(message) => control_error! { message },
            }
        }
        ControlCommand::StopMidiRecording => {
            match MIDI_INPUT
                .get()
                .ok_or_else(|| "MIDI input actor is unavailable".to_owned())
                .and_then(|actor| actor.stop_recording())
            {
                Ok(recording) => ControlResult::MidiRecordingStopped { recording },
                Err(message) => control_error! { message },
            }
        }
        ControlCommand::RecordingWaveform {
            start_frame,
            end_frame,
            max_buckets,
        } => match audio_engine.recording_waveform_snapshot(start_frame, end_frame, max_buckets) {
            Ok(value) => ControlResult::RecordingWaveform {
                waveform: recording_waveform(value),
            },
            Err(error) => control_error! {
                message: error.to_string(),
            },
        },
        _ => return None,
    };
    Some(result)
}
