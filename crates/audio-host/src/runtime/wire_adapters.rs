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

fn live_graph(
    generation: u64,
    value: &LiveMixerGraph,
    processors: Option<&HashMap<String, vst3::Vst3ProcessorHandle>>,
    request_arena: &ArenaReceiver,
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
            Ok(engine::NativeMixerChannel {
                id: channel.id.clone(),
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
                hardware_output_channels: channel.hardware_output_channels.clone(),
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
                latency_samples: plugin.latency_samples,
                tail_samples: plugin.tail_samples,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let midi_clips = value
        .midi_clips
        .iter()
        .map(|clip| {
            let notes = resolve_midi_note_batch(&clip.notes, request_arena)
                .map_err(|error| error.to_string())?;
            let mut native_notes = Vec::with_capacity(notes.len());
            match notes {
                MidiNoteBatchView::Inline(notes) => {
                    native_notes.extend(notes.iter().map(|note| engine::NativeMidiNote {
                        start_tick: note.start_tick,
                        duration_ticks: note.duration_ticks,
                        channel: note.channel,
                        key: note.key,
                        velocity: note.velocity,
                        release_velocity: note.release_velocity,
                    }));
                }
                MidiNoteBatchView::Shared(notes) => {
                    native_notes.extend(notes.iter().copied().map(|note| engine::NativeMidiNote {
                        start_tick: note.start_tick(),
                        duration_ticks: note.duration_ticks(),
                        channel: note.channel(),
                        key: note.key(),
                        velocity: note.velocity(),
                        release_velocity: note.release_velocity(),
                    }));
                }
            }
            Ok(engine::NativeMidiClip {
                id: clip.id.clone(),
                channel_index: channel_index(&clip.channel_id)?,
                start_tick: clip.start_tick,
                source_offset_ticks: clip.source_offset_ticks,
                length_ticks: clip.length_ticks,
                notes: native_notes,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(engine::NativeMixerGraph {
        generation,
        sample_rate: value.sample_rate,
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

fn engine_command(
    command: ControlCommand,
    processors: Option<&HashMap<String, vst3::Vst3ProcessorHandle>>,
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
                    return Some(ControlResult::Error {
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
        ControlCommand::StartAudioEngine { config } => {
            match engine::start_audio_engine(engine::NativeAudioEngineConfig {
                backend: config.backend,
                input_device_id: config.input_device_id,
                output_device_id: config.output_device_id,
                buffer_size: config.buffer_size,
                session_sample_rate: config.session_sample_rate,
            }) {
                Ok(runtime) => ControlResult::AudioRuntime {
                    runtime: audio_runtime(runtime),
                },
                Err(error) => ControlResult::Error {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::StopAudioEngine => match engine::stop_audio_engine() {
            Ok(runtime) => ControlResult::AudioRuntime {
                runtime: audio_runtime(runtime),
            },
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
        },
        ControlCommand::AudioEngineSnapshot => match engine::audio_engine_snapshot() {
            Ok(runtime) => ControlResult::AudioRuntime {
                runtime: audio_runtime(runtime),
            },
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
        },
        ControlCommand::StartRoundTripLatencyMeasurement { request } => {
            match engine::start_round_trip_latency_measurement(
                engine::NativeRoundTripLatencyMeasurementRequest {
                    input_channel: request.input_channel,
                    output_channel: request.output_channel,
                },
            ) {
                Ok(measurement) => ControlResult::RoundTripLatencyMeasurement {
                    measurement: round_trip_latency_measurement(measurement),
                },
                Err(error) => ControlResult::Error {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::RoundTripLatencyMeasurementSnapshot => {
            match engine::round_trip_latency_measurement_snapshot() {
                Ok(measurement) => ControlResult::RoundTripLatencyMeasurement {
                    measurement: round_trip_latency_measurement(measurement),
                },
                Err(error) => ControlResult::Error {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::UpdateGraph {
            update: GraphUpdate::Replace { revision, graph },
        } => {
            let inline_arena = ArenaReceiver::new(1);
            match live_graph(revision, &graph, processors, &inline_arena).and_then(|graph| {
                engine::load_mixer_graph(graph).map_err(|error| error.to_string())
            }) {
                Ok(()) => ControlResult::GraphAccepted { revision },
                Err(error) => ControlResult::Error { message: error },
            }
        }
        ControlCommand::UpdateGraph {
            update: GraphUpdate::Patch { .. },
        } => ControlResult::Error {
            message: "graph patches require the IPC protocol actor".into(),
        },
        ControlCommand::PreviewMixerParameter { preview } => {
            match engine::preview_mixer_parameter(engine::NativeMixerParameterPreview {
                target: preview.target,
                id: preview.id,
                parameter: preview.parameter,
                value: preview.value,
            }) {
                Ok(()) => ControlResult::Accepted,
                Err(error) => ControlResult::Error {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::MixerSnapshot => match engine::mixer_snapshot() {
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
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
        },
        ControlCommand::CompiledGraphSnapshot => ControlResult::CompiledGraphSnapshot {
            snapshot: engine::compiled_audio_graph_snapshot(),
        },
        ControlCommand::ClearMeterClips => {
            match engine::transport_command("clear-meter-clips".to_owned(), None) {
                Ok(_) => ControlResult::Accepted,
                Err(error) => ControlResult::Error {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::Transport { command } => {
            match engine::transport_command(command.kind, command.position_frames) {
                Ok(value) => ControlResult::TransportSnapshot {
                    transport: TransportState {
                        state: value.state,
                        position_frames: value.position_frames,
                        sample_rate: value.sample_rate,
                    },
                },
                Err(error) => ControlResult::Error {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::TransportSnapshot => match engine::transport_snapshot() {
            Ok(value) => ControlResult::TransportSnapshot {
                transport: TransportState {
                    state: value.state,
                    position_frames: value.position_frames,
                    sample_rate: value.sample_rate,
                },
            },
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
        },
        ControlCommand::StartRecording { config } => {
            match engine::start_recording(NativeRecordingStartConfig {
                path: config.path,
                asset_id: config.asset_id,
                originator: config.originator,
                origination_date: config.origination_date,
                origination_time: config.origination_time,
                time_reference: config.time_reference,
            }) {
                Ok(()) => ControlResult::Accepted,
                Err(error) => ControlResult::Error {
                    message: error.to_string(),
                },
            }
        }
        ControlCommand::StopRecording => match engine::stop_recording() {
            Ok(value) => ControlResult::RecordingStopped {
                recording: recording_result(value),
            },
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
        },
        ControlCommand::RecordingWaveform {
            start_frame,
            end_frame,
            max_buckets,
        } => match engine::recording_waveform_snapshot(start_frame, end_frame, max_buckets) {
            Ok(value) => ControlResult::RecordingWaveform {
                waveform: recording_waveform(value),
            },
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
        },
        _ => return None,
    };
    Some(result)
}

fn run_legacy() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let mut crash_marker_path: Option<PathBuf> = None;
    while let Some(argument) = arguments.next() {
        if argument == "--crash-marker" {
            crash_marker_path = arguments.next().map(PathBuf::from);
        }
    }
    if let Some(path) = crash_marker_path.as_deref() {
        crash_marker::initialize(path)
            .map_err(|error| format!("could not initialize crash marker: {error}"))?;
    }
    let mut vst3 = Some(vst3::Vst3Runtime::new());
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    loop {
        let request: ControlRequest = read_message(&mut input)?;
        let result = match request.command {
            ControlCommand::BenchmarkEcho { payload } => ControlResult::BenchmarkEcho { payload },
            ControlCommand::Ping => {
                if let Some(runtime) = vst3.as_ref() {
                    for (instance_id, latency, tail) in runtime.take_timing_changes() {
                        if let Err(error) =
                            engine::update_plugin_timing(&instance_id, latency, tail)
                        {
                            eprintln!(
                                "audio-host: could not rebuild dynamic plugin latency: {error}"
                            );
                        }
                    }
                }
                let (callback_generation, transport_state) = engine::heartbeat_snapshot();
                ControlResult::Heartbeat {
                    ipc_generation: 0,
                    tokio_generation: 0,
                    winit_generation: 0,
                    callback_generation,
                    transport_state,
                }
            }
            command @ (ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::PluginParameters { .. }
            | ControlCommand::SetPluginParameter { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ClosePluginEditor { .. }) => match vst3.as_mut() {
                Some(runtime) => runtime.execute(command),
                None => ControlResult::Error {
                    message: "VST3 runtime is not configured".into(),
                },
            },
            ControlCommand::Shutdown => {
                let _ = engine::stop_audio_engine();
                write_message(
                    &mut output,
                    &ControlResponse {
                        request_id: request.request_id,
                        result: ControlResult::Accepted,
                    },
                )?;
                return Ok(());
            }
            command => {
                let processors = vst3.as_ref().map(vst3::Vst3Runtime::processor_handles);
                match engine_command(command, processors.as_ref()) {
                    Some(result) => result,
                    None => ControlResult::Error {
                        message: "unsupported audio-host command".into(),
                    },
                }
            }
        };
        write_message(
            &mut output,
            &ControlResponse {
                request_id: request.request_id,
                result,
            },
        )?;
    }
}
