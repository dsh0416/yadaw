use std::{
    collections::HashMap,
    env,
    io::{self, BufReader, BufWriter},
    path::PathBuf,
    process::ExitCode,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc as std_mpsc,
    },
    thread,
};

use iced_tiny_skia::window::Compositor as TinySkiaCompositor;
use ipc_channel::ipc::{self, IpcSender};
use tokio::{
    sync::{Semaphore, mpsc, oneshot, watch},
    task::JoinSet,
};
#[cfg(target_os = "macos")]
use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    window::{WindowAttributes, WindowId},
};
use yadaw_audio_host::{
    crash_marker, device,
    editor_platform::{self, NativeUiContext},
    editor_window::{EditorAction, EditorWindow},
    engine,
    recording::{NativeRecordingResult, NativeRecordingStartConfig, NativeWaveformSnapshot},
    vst3,
};
use yadaw_dsp_runtime::protocol::{
    AudioBackend, AudioDevice, AudioDeviceList, AudioRuntime, BinaryPayload, ControlCommand,
    ControlRequest, ControlResponse, ControlResult, GraphUpdate, HostEvent, LiveMixerGraph,
    MixerChannelMeter, NATIVE_BUILD_FINGERPRINT, PluginEditorPreference, PriorityCommand,
    PriorityRequest, PriorityResponse, PriorityResult, RecordingResult, RecordingWaveform,
    TransportState, read_message, write_message,
};
use yadaw_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};
use yadaw_ipc_transport::{
    ArenaReceiver, HostBootstrap, LeaseRegistry, MidiNoteBatchView, ParameterConsumer, RegionOffer,
    ResolvedBlob, TelemetryMeter, TelemetrySnapshot, TelemetryWriter, WirePacket,
    create_telemetry_page, decode_body, decode_request_deferred, encode_event, encode_priority,
    encode_response_from_arena, materialize_mixer_graph, resolve_midi_note_batch,
};

fn audio_runtime(value: engine::NativeAudioRuntimeSnapshot) -> AudioRuntime {
    AudioRuntime {
        state: value.state,
        requested_buffer_size: value.requested_buffer_size,
        sample_rate: value.sample_rate,
        input_sample_rate: value.input_sample_rate,
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
                record_armed: channel.record_armed,
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
                target_index: channel_index(&send.target_channel_id)?,
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

struct ActorRequest {
    command: ActorCommand,
    reply: oneshot::Sender<ControlResult>,
}

async fn forward_to_ui(
    sender: &std_mpsc::SyncSender<ActorRequest>,
    proxy: &EventLoopProxy<UiEvent>,
    mut request: ActorRequest,
) {
    loop {
        match sender.try_send(request) {
            Ok(()) => {
                let _ = proxy.send_event(UiEvent::Wake);
                return;
            }
            Err(std_mpsc::TrySendError::Full(returned)) => {
                request = returned;
                tokio::task::yield_now().await;
            }
            Err(std_mpsc::TrySendError::Disconnected(returned)) => {
                let _ = returned.reply.send(ControlResult::Error {
                    message: "winit VST3 UI mailbox stopped".into(),
                });
                return;
            }
        }
    }
}

enum ActorCommand {
    Control(ControlCommand),
    Parameter(yadaw_dsp_runtime::protocol::ParameterCommand),
}

#[derive(Default)]
struct GraphParameterHandles {
    channels: HashMap<u32, String>,
    sends: HashMap<u32, String>,
}

fn stable_runtime_handle(namespace: u8, id: &str) -> u32 {
    let mut value = 2_166_136_261_u32 ^ u32::from(namespace);
    for byte in id.bytes() {
        value ^= u32::from(byte);
        value = value.wrapping_mul(16_777_619);
    }
    value.max(1)
}

fn refresh_graph_handles(handles: &Mutex<GraphParameterHandles>, graph: &LiveMixerGraph) {
    if let Ok(mut handles) = handles.lock() {
        handles.channels = graph
            .channels
            .iter()
            .map(|channel| (stable_runtime_handle(1, &channel.id), channel.id.clone()))
            .collect();
        handles.sends = graph
            .sends
            .iter()
            .map(|send| (stable_runtime_handle(2, &send.id), send.id.clone()))
            .collect();
    }
}

fn mixer_parameter_command(
    handles: &Mutex<GraphParameterHandles>,
    command: yadaw_dsp_runtime::protocol::ParameterCommand,
) -> ControlResult {
    let mapping = handles.lock().ok();
    let (target, id, parameter, value) = match command.target_kind {
        yadaw_dsp_runtime::protocol::ParameterTargetKind::MixerChannel => {
            let Some(id) = mapping
                .as_ref()
                .and_then(|values| values.channels.get(&command.runtime_handle))
                .cloned()
            else {
                return ControlResult::Error {
                    message: "mixer channel runtime handle is stale".into(),
                };
            };
            let (parameter, value) = match command.parameter_id {
                0 => ("gainDb", -60.0 + command.normalized * 72.0),
                1 => ("pan", command.normalized * 2.0 - 1.0),
                _ => {
                    return ControlResult::Error {
                        message: "unknown mixer channel parameter".into(),
                    };
                }
            };
            ("channel", id, parameter, value)
        }
        yadaw_dsp_runtime::protocol::ParameterTargetKind::MixerSend => {
            let Some(id) = mapping
                .as_ref()
                .and_then(|values| values.sends.get(&command.runtime_handle))
                .cloned()
            else {
                return ControlResult::Error {
                    message: "mixer send runtime handle is stale".into(),
                };
            };
            let (parameter, value) = match command.parameter_id {
                0 => ("levelDb", -60.0 + command.normalized * 72.0),
                1 => ("pan", command.normalized * 2.0 - 1.0),
                _ => {
                    return ControlResult::Error {
                        message: "unknown mixer send parameter".into(),
                    };
                }
            };
            ("send", id, parameter, value)
        }
        yadaw_dsp_runtime::protocol::ParameterTargetKind::Plugin => {
            return ControlResult::Error {
                message: "plugin parameter was routed to the engine actor".into(),
            };
        }
    };
    match engine::preview_mixer_parameter(engine::NativeMixerParameterPreview {
        target: target.into(),
        id,
        parameter: parameter.into(),
        value,
    }) {
        Ok(()) => ControlResult::Accepted,
        Err(error) => ControlResult::Error {
            message: error.to_string(),
        },
    }
}

async fn engine_actor(
    mut inbox: mpsc::Receiver<ActorRequest>,
    handles: Arc<Mutex<GraphParameterHandles>>,
) {
    while let Some(message) = inbox.recv().await {
        let result = match message.command {
            ActorCommand::Control(command) => {
                engine_command(command, None).unwrap_or(ControlResult::Error {
                    message: "unsupported engine command".into(),
                })
            }
            ActorCommand::Parameter(command) => mixer_parameter_command(&handles, command),
        };
        let _ = message.reply.send(result);
    }
}

async fn background_io_actor(mut inbox: mpsc::Receiver<ActorRequest>) {
    while let Some(message) = inbox.recv().await {
        let result = match message.command {
            ActorCommand::Control(command) => {
                engine_command(command, None).unwrap_or(ControlResult::Error {
                    message: "unsupported background I/O command".into(),
                })
            }
            ActorCommand::Parameter(_) => ControlResult::Error {
                message: "background I/O actor does not own parameters".into(),
            },
        };
        let _ = message.reply.send(result);
    }
}

enum DeferredBinary {
    Inline(Vec<u8>),
    Shared(ResolvedBlob),
}

impl DeferredBinary {
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Inline(bytes) => bytes,
            Self::Shared(blob) => blob.as_slice(),
        }
    }
}

fn resolve_deferred_binary(
    payload: BinaryPayload,
    arena: &Arc<Mutex<ArenaReceiver>>,
) -> Result<DeferredBinary, String> {
    match payload {
        BinaryPayload::Inline { bytes } => Ok(DeferredBinary::Inline(bytes)),
        BinaryPayload::Shared { reference } => arena
            .lock()
            .map_err(|_| "request arena is poisoned".to_owned())?
            .acquire(reference)
            .map(DeferredBinary::Shared)
            .map_err(|error| error.to_string()),
        BinaryPayload::Attachment { .. } => {
            Err("VST3 state still references a Node attachment".to_owned())
        }
    }
}

async fn vst3_actor(
    mut inbox: mpsc::Receiver<ActorRequest>,
    ui_proxy: EventLoopProxy<UiEvent>,
    ui_sender: std_mpsc::SyncSender<ActorRequest>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    handles: Arc<Mutex<GraphParameterHandles>>,
    request_arena: Arc<Mutex<ArenaReceiver>>,
) {
    let mut graph_revision = 0_u64;
    let mut graph_snapshot: Option<LiveMixerGraph> = None;
    while let Some(message) = inbox.recv().await {
        let result = match message.command {
            ActorCommand::Parameter(command) => {
                forward_to_ui(
                    &ui_sender,
                    &ui_proxy,
                    ActorRequest {
                        command: ActorCommand::Parameter(command),
                        reply: message.reply,
                    },
                )
                .await;
                continue;
            }
            ActorCommand::Control(command) => match command {
                ControlCommand::Ping => {
                    forward_to_ui(
                        &ui_sender,
                        &ui_proxy,
                        ActorRequest {
                            command: ActorCommand::Control(ControlCommand::Ping),
                            reply: message.reply,
                        },
                    )
                    .await;
                    continue;
                }
                ControlCommand::LoadPlugin {
                    instance_id,
                    module_path,
                    class_id,
                    plugin_kind,
                    sample_rate,
                    component_state,
                    controller_state,
                } => {
                    let component_state = resolve_deferred_binary(component_state, &request_arena);
                    let controller_state =
                        resolve_deferred_binary(controller_state, &request_arena);
                    match (component_state, controller_state) {
                        (Ok(component_state), Ok(controller_state)) => {
                            forward_to_ui(
                                &ui_sender,
                                &ui_proxy,
                                ActorRequest {
                                    command: ActorCommand::Control(ControlCommand::LoadPlugin {
                                        instance_id,
                                        module_path,
                                        class_id,
                                        plugin_kind,
                                        sample_rate,
                                        component_state: BinaryPayload::inline(
                                            component_state.as_slice().to_vec(),
                                        ),
                                        controller_state: BinaryPayload::inline(
                                            controller_state.as_slice().to_vec(),
                                        ),
                                    }),
                                    reply: message.reply,
                                },
                            )
                            .await;
                            continue;
                        }
                        (Err(message), _) | (_, Err(message)) => ControlResult::Error { message },
                    }
                }
                command @ (ControlCommand::UnloadPlugin { .. }
                | ControlCommand::PluginParameters { .. }
                | ControlCommand::SetPluginParameter { .. }
                | ControlCommand::SavePluginState { .. }
                | ControlCommand::OpenPluginEditor { .. }
                | ControlCommand::ClosePluginEditor { .. }) => {
                    forward_to_ui(
                        &ui_sender,
                        &ui_proxy,
                        ActorRequest {
                            command: ActorCommand::Control(command),
                            reply: message.reply,
                        },
                    )
                    .await;
                    continue;
                }
                ControlCommand::UpdateGraph { update } => {
                    let (revision, mut candidate) = match update {
                        GraphUpdate::Replace { revision, graph } => (revision, graph),
                        GraphUpdate::Patch {
                            base_revision,
                            revision,
                            ops,
                        } => {
                            if base_revision != graph_revision {
                                let _ = message.reply.send(ControlResult::RevisionMismatch {
                                    current_revision: graph_revision,
                                });
                                continue;
                            }
                            let Some(mut graph) = graph_snapshot.clone() else {
                                let _ = message.reply.send(ControlResult::RevisionMismatch {
                                    current_revision: graph_revision,
                                });
                                continue;
                            };
                            graph.apply_ops(ops);
                            (revision, graph)
                        }
                    };
                    let arena = request_arena
                        .lock()
                        .map_err(|_| "request arena is poisoned".to_owned())
                        .map(|arena| arena.clone());
                    let compiled = arena.and_then(|arena| {
                        let processors = processors
                            .lock()
                            .map_err(|_| "VST3 processor registry is poisoned".to_owned())?
                            .clone();
                        let graph = live_graph(revision, &candidate, Some(&processors), &arena)?;
                        materialize_mixer_graph(&mut candidate, &arena)
                            .map_err(|error| error.to_string())?;
                        engine::load_mixer_graph(graph).map_err(|error| error.to_string())
                    });
                    match compiled {
                        Ok(()) => {
                            refresh_graph_handles(&handles, &candidate);
                            graph_revision = revision;
                            graph_snapshot = Some(candidate);
                            ControlResult::GraphAccepted { revision }
                        }
                        Err(message) => ControlResult::Error { message },
                    }
                }
                _ => ControlResult::Error {
                    message: "unsupported VST3 actor command".into(),
                },
            },
        };
        let _ = message.reply.send(result);
    }
}

async fn dispatch_actor(
    sender: &mpsc::Sender<ActorRequest>,
    command: ControlCommand,
) -> ControlResult {
    let (reply, response) = oneshot::channel();
    if sender
        .send(ActorRequest {
            command: ActorCommand::Control(command),
            reply,
        })
        .await
        .is_err()
    {
        return ControlResult::Error {
            message: "audio-host actor stopped".into(),
        };
    }
    response.await.unwrap_or(ControlResult::Error {
        message: "audio-host actor dropped its response".into(),
    })
}

async fn dispatch_parameter(
    sender: &mpsc::Sender<ActorRequest>,
    command: yadaw_dsp_runtime::protocol::ParameterCommand,
) -> ControlResult {
    let (reply, response) = oneshot::channel();
    if sender
        .send(ActorRequest {
            command: ActorCommand::Parameter(command),
            reply,
        })
        .await
        .is_err()
    {
        return ControlResult::Error {
            message: "audio-host parameter actor stopped".into(),
        };
    }
    response.await.unwrap_or(ControlResult::Error {
        message: "audio-host parameter actor dropped its response".into(),
    })
}

fn is_vst3_command(command: &ControlCommand) -> bool {
    matches!(
        command,
        ControlCommand::Ping
            | ControlCommand::UpdateGraph { .. }
            | ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::PluginParameters { .. }
            | ControlCommand::SetPluginParameter { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ClosePluginEditor { .. }
    )
}

fn is_background_io_command(command: &ControlCommand) -> bool {
    matches!(
        command,
        ControlCommand::ListAudioBackends | ControlCommand::ListAudioDevices { .. }
    )
}

fn protocol_deadline(command: &ControlCommand) -> std::time::Duration {
    if matches!(
        command,
        ControlCommand::UpdateGraph { .. }
            | ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ClosePluginEditor { .. }
    ) {
        std::time::Duration::from_secs(15)
    } else {
        std::time::Duration::from_secs(2)
    }
}

struct InboundRequest {
    request: ControlRequest,
    received_leases: Vec<u64>,
}

enum PriorityIngress {
    ParameterWake,
    ParameterBoundary(yadaw_dsp_runtime::protocol::ParameterCommand),
    Shutdown,
    TelemetryPageReady,
}

enum OutboundMessage {
    Response {
        value: ControlResponse,
        request_leases: Vec<u64>,
    },
    Event(WirePacket),
}

fn response(request_id: u64, result: ControlResult) -> ControlResponse {
    ControlResponse { request_id, result }
}

#[derive(Clone)]
struct EgressArenas {
    responses: Arc<Mutex<LeaseRegistry>>,
    requests: Arc<Mutex<ArenaReceiver>>,
}

async fn run_egress(
    mut outbound: mpsc::Receiver<OutboundMessage>,
    responses: ipc_channel::ipc::IpcSender<WirePacket>,
    events: ipc_channel::ipc::IpcSender<WirePacket>,
    arenas: EgressArenas,
    concurrency: usize,
    mut shutdown: watch::Receiver<bool>,
    metrics: Arc<EgressMetrics>,
) {
    let permits = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut responses_inflight = JoinSet::new();
    let mut lease_reaper = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        let queue_depth = outbound.len() as u64;
        metrics.queue_depth.store(queue_depth, Ordering::Release);
        metrics
            .queue_high_water
            .fetch_max(queue_depth, Ordering::AcqRel);
        tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    while let Ok(message) = outbound.try_recv() {
                        dispatch_egress(
                            message,
                            &responses,
                            &events,
                            &arenas,
                            &permits,
                            &mut responses_inflight,
                            &metrics,
                        ).await;
                    }
                    break;
                }
            }
            Some(result) = responses_inflight.join_next(), if !responses_inflight.is_empty() => {
                if let Err(error) = result {
                    eprintln!("audio-host: IPC response task failed: {error}");
                }
            }
            _ = lease_reaper.tick() => {
                if let Ok(mut leases) = arenas.responses.lock() {
                    for lease_id in leases.reap_expired() {
                        eprintln!("audio-host: arena lease {lease_id} expired; region quarantined");
                    }
                    publish_arena_metrics(&metrics, &leases);
                }
            }
            message = outbound.recv() => {
                let Some(message) = message else { break };
                dispatch_egress(
                    message,
                    &responses,
                    &events,
                    &arenas,
                    &permits,
                    &mut responses_inflight,
                    &metrics,
                ).await;
            }
        }
    }
    while let Some(result) = responses_inflight.join_next().await {
        if let Err(error) = result {
            eprintln!("audio-host: IPC response task failed during drain: {error}");
        }
    }
}

async fn dispatch_egress(
    message: OutboundMessage,
    responses: &ipc_channel::ipc::IpcSender<WirePacket>,
    events: &ipc_channel::ipc::IpcSender<WirePacket>,
    arenas: &EgressArenas,
    permits: &Arc<Semaphore>,
    inflight: &mut JoinSet<()>,
    metrics: &Arc<EgressMetrics>,
) {
    metrics.batches.fetch_add(1, Ordering::Relaxed);
    match message {
        OutboundMessage::Response {
            value,
            request_leases,
        } => {
            let Ok(permit) = permits.clone().acquire_owned().await else {
                return;
            };
            let responses = responses.clone();
            let events = events.clone();
            let leases = arenas.responses.clone();
            let request_arena = arenas.requests.clone();
            let metrics = metrics.clone();
            metrics.active.fetch_add(1, Ordering::AcqRel);
            metrics.blocking_jobs.fetch_add(1, Ordering::AcqRel);
            inflight.spawn_blocking(move || {
                let _permit = permit;
                let sent = request_arena
                    .lock()
                    .map_err(|_| "request arena is poisoned".to_owned())
                    .and_then(|source| {
                        leases
                            .lock()
                            .map_err(|_| "response arena is poisoned".to_owned())
                            .and_then(|mut arena| {
                                let result = encode_response_from_arena(value, &mut arena, &source)
                                    .map_err(|error| error.to_string());
                                publish_arena_metrics(&metrics, &arena);
                                result
                            })
                    })
                    .and_then(|packet| responses.send(packet).map_err(|error| error.to_string()));
                if let Err(error) = sent {
                    eprintln!("audio-host: IPC response stopped: {error}");
                } else if !request_leases.is_empty()
                    && let Ok(packet) = encode_event(
                        &HostEvent::ReleaseLeases {
                            lease_ids: request_leases,
                        },
                        Vec::new(),
                    )
                    && let Err(error) = events.send(packet)
                {
                    eprintln!("audio-host: request lease release event stopped: {error}");
                }
                metrics.active.fetch_sub(1, Ordering::AcqRel);
                metrics.blocking_jobs.fetch_sub(1, Ordering::AcqRel);
            });
        }
        OutboundMessage::Event(packet) => {
            let events = events.clone();
            metrics.blocking_jobs.fetch_add(1, Ordering::AcqRel);
            let sent = tokio::task::spawn_blocking(move || events.send(packet))
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result.map_err(|error| error.to_string()));
            metrics.blocking_jobs.fetch_sub(1, Ordering::AcqRel);
            if let Err(error) = sent {
                eprintln!("audio-host: IPC event lane stopped: {error}");
            }
        }
    }
}

#[derive(Default)]
struct EgressMetrics {
    active: AtomicU64,
    queue_depth: AtomicU64,
    queue_high_water: AtomicU64,
    batches: AtomicU64,
    blocking_jobs: AtomicU64,
    arena_regions: AtomicU64,
    arena_capacity_bytes: AtomicU64,
    arena_used_bytes: AtomicU64,
    arena_high_water_bytes: AtomicU64,
    arena_offers: AtomicU64,
    arena_busy: AtomicU64,
    arena_quarantined_regions: AtomicU64,
    arena_copied_bytes: AtomicU64,
}

fn publish_arena_metrics(metrics: &EgressMetrics, arena: &LeaseRegistry) {
    let diagnostics = arena.diagnostics();
    metrics
        .arena_regions
        .store(u64::from(diagnostics.region_count), Ordering::Release);
    metrics
        .arena_capacity_bytes
        .store(diagnostics.capacity_bytes, Ordering::Release);
    metrics
        .arena_used_bytes
        .store(diagnostics.used_bytes, Ordering::Release);
    metrics
        .arena_high_water_bytes
        .store(diagnostics.high_water_bytes, Ordering::Release);
    metrics
        .arena_offers
        .store(diagnostics.offers, Ordering::Release);
    metrics
        .arena_busy
        .store(diagnostics.busy, Ordering::Release);
    metrics
        .arena_quarantined_regions
        .store(diagnostics.quarantined_regions, Ordering::Release);
    metrics
        .arena_copied_bytes
        .store(diagnostics.copied_bytes, Ordering::Release);
}

struct Liveness {
    ipc: Arc<AtomicU64>,
    tokio: Arc<AtomicU64>,
    winit: Arc<AtomicU64>,
    egress: Arc<EgressMetrics>,
}

struct IngressChannels {
    requests: ipc_channel::ipc::IpcReceiver<WirePacket>,
    priority_requests: ipc_channel::ipc::IpcReceiver<WirePacket>,
    priority_responses: ipc_channel::ipc::IpcSender<WirePacket>,
}

struct IngressMailboxes {
    inbound: mpsc::Sender<InboundRequest>,
    priority: mpsc::Sender<PriorityIngress>,
    outbound: mpsc::Sender<OutboundMessage>,
}

fn spawn_ingress(
    channels: IngressChannels,
    mailboxes: IngressMailboxes,
    leases: Arc<Mutex<LeaseRegistry>>,
    request_arena: Arc<Mutex<ArenaReceiver>>,
    liveness: Liveness,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name("yadaw-ipc-ingress".into())
        .spawn(move || {
            let mut receivers = match ipc_channel::ipc::IpcReceiverSet::new() {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("audio-host: could not create IPC receiver set: {error}");
                    return;
                }
            };
            let normal_id = match receivers.add(channels.requests) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("audio-host: could not register normal IPC receiver: {error}");
                    return;
                }
            };
            let priority_id = match receivers.add(channels.priority_requests) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("audio-host: could not register priority IPC receiver: {error}");
                    return;
                }
            };
            let mut normal_open = true;
            let mut priority_open = true;
            while normal_open || priority_open {
                let mut selected = match receivers.select() {
                    Ok(value) => value,
                    Err(error) => {
                        eprintln!("audio-host: IPC receiver set stopped: {error}");
                        break;
                    }
                };
                // A heartbeat that arrived in the same kernel wake is always handled
                // before ordinary work is offered to Tokio.
                selected.sort_by_key(|selection| match selection {
                    ipc_channel::ipc::IpcSelectionResult::MessageReceived(id, _)
                    | ipc_channel::ipc::IpcSelectionResult::ChannelClosed(id) => {
                        usize::from(*id != priority_id)
                    }
                });
                for selection in selected {
                    let (id, message) = match selection {
                        ipc_channel::ipc::IpcSelectionResult::MessageReceived(id, message) => {
                            (id, message)
                        }
                        ipc_channel::ipc::IpcSelectionResult::ChannelClosed(id) => {
                            if id == normal_id {
                                normal_open = false;
                            } else if id == priority_id {
                                priority_open = false;
                            }
                            continue;
                        }
                    };
                    let packet = match message.to::<WirePacket>() {
                        Ok(value) => value,
                        Err(error) => {
                            eprintln!("audio-host: invalid IPC packet: {error}");
                            continue;
                        }
                    };
                    let ipc_generation = liveness.ipc.fetch_add(1, Ordering::AcqRel) + 1;
                    if id == normal_id {
                        let decoded = request_arena
                            .lock()
                            .map_err(|_| "request arena is poisoned".to_owned())
                            .and_then(|mut arena| {
                                decode_request_deferred(packet, &mut arena)
                                    .map_err(|error| error.to_string())
                            });
                        let (request, received_leases) = match decoded {
                            Ok(value) => value,
                            Err(error) => {
                                eprintln!("audio-host: rejected invalid request packet: {error}");
                                continue;
                            }
                        };
                        let request_id = request.request_id;
                        match mailboxes.inbound.try_send(InboundRequest {
                            request,
                            received_leases,
                        }) {
                            Ok(()) => {}
                            Err(mpsc::error::TrySendError::Full(inbound)) => {
                                let _ = mailboxes.outbound.try_send(OutboundMessage::Response {
                                    value: response(request_id, ControlResult::Busy),
                                    request_leases: inbound.received_leases,
                                });
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => return,
                        }
                        continue;
                    }
                    let request = match decode_body::<PriorityRequest>(&packet.body) {
                        Ok(request) => request,
                        Err(error) => {
                            eprintln!("audio-host: invalid priority request: {error}");
                            continue;
                        }
                    };
                    let result = match request.command {
                        PriorityCommand::Heartbeat => {
                            let (callback_generation, transport_state) =
                                engine::heartbeat_snapshot();
                            PriorityResult::Heartbeat {
                                ipc_generation,
                                tokio_generation: liveness.tokio.load(Ordering::Acquire),
                                winit_generation: liveness.winit.load(Ordering::Acquire),
                                callback_generation,
                                transport_state,
                                egress_active: liveness.egress.active.load(Ordering::Acquire),
                                egress_queue_depth: liveness
                                    .egress
                                    .queue_depth
                                    .load(Ordering::Acquire),
                                egress_queue_high_water: liveness
                                    .egress
                                    .queue_high_water
                                    .load(Ordering::Acquire),
                                egress_batches: liveness.egress.batches.load(Ordering::Acquire),
                                blocking_jobs: liveness
                                    .egress
                                    .blocking_jobs
                                    .load(Ordering::Acquire),
                                arena_regions: liveness
                                    .egress
                                    .arena_regions
                                    .load(Ordering::Acquire),
                                arena_capacity_bytes: liveness
                                    .egress
                                    .arena_capacity_bytes
                                    .load(Ordering::Acquire),
                                arena_used_bytes: liveness
                                    .egress
                                    .arena_used_bytes
                                    .load(Ordering::Acquire),
                                arena_high_water_bytes: liveness
                                    .egress
                                    .arena_high_water_bytes
                                    .load(Ordering::Acquire),
                                arena_offers: liveness.egress.arena_offers.load(Ordering::Acquire),
                                arena_busy: liveness.egress.arena_busy.load(Ordering::Acquire),
                                arena_quarantined_regions: liveness
                                    .egress
                                    .arena_quarantined_regions
                                    .load(Ordering::Acquire),
                                arena_copied_bytes: liveness
                                    .egress
                                    .arena_copied_bytes
                                    .load(Ordering::Acquire),
                            }
                        }
                        PriorityCommand::ReleaseLeases { lease_ids } => {
                            if let Ok(mut leases) = leases.lock() {
                                leases.release(&lease_ids);
                            }
                            PriorityResult::Accepted
                        }
                        PriorityCommand::ParameterWake => {
                            match mailboxes.priority.try_send(PriorityIngress::ParameterWake) {
                                Ok(()) => PriorityResult::Accepted,
                                Err(_) => PriorityResult::Busy,
                            }
                        }
                        PriorityCommand::ParameterBoundary { command } => {
                            match mailboxes
                                .priority
                                .try_send(PriorityIngress::ParameterBoundary(command))
                            {
                                Ok(()) => PriorityResult::Accepted,
                                Err(_) => PriorityResult::Busy,
                            }
                        }
                        PriorityCommand::Shutdown => {
                            match mailboxes.priority.try_send(PriorityIngress::Shutdown) {
                                Ok(()) => PriorityResult::Accepted,
                                Err(_) => PriorityResult::Busy,
                            }
                        }
                        PriorityCommand::TelemetryPageReady { .. } => {
                            match mailboxes
                                .priority
                                .try_send(PriorityIngress::TelemetryPageReady)
                            {
                                Ok(()) => PriorityResult::Accepted,
                                Err(_) => PriorityResult::Busy,
                            }
                        }
                    };
                    let reply = PriorityResponse {
                        request_id: request.request_id,
                        result,
                    };
                    let packet = match encode_priority(&reply) {
                        Ok(packet) => packet,
                        Err(error) => {
                            eprintln!("audio-host: could not encode priority response: {error}");
                            continue;
                        }
                    };
                    if let Err(error) = channels.priority_responses.send(packet) {
                        eprintln!("audio-host: priority response failed: {error}");
                        return;
                    }
                }
            }
        })
        .expect("IPC ingress thread must start")
}

fn transport_state_code(state: &str) -> u32 {
    match state {
        "playing" => 1,
        "recording" => 2,
        "paused" => 3,
        _ => 0,
    }
}

async fn publish_telemetry(
    writer: &Arc<Mutex<TelemetryWriter>>,
    outbound: &mpsc::Sender<OutboundMessage>,
    graph_revision: u64,
    session_epoch: u64,
    page_epoch: &AtomicU64,
) {
    let (callback_generation, transport_state) = engine::heartbeat_snapshot();
    let transport = engine::transport_snapshot().ok();
    let meter_values = engine::mixer_snapshot()
        .map(|snapshot| snapshot.meters)
        .unwrap_or_default();
    let meters = meter_values
        .iter()
        .map(|meter| TelemetryMeter {
            runtime_handle: stable_runtime_handle(1, &meter.channel_id),
            pre_left: meter.pre_left as f32,
            pre_right: meter.pre_right as f32,
            post_left: meter.post_left as f32,
            post_right: meter.post_right as f32,
            held_left: meter.held_left as f32,
            held_right: meter.held_right as f32,
            clipped: meter.clipped,
        })
        .collect::<Vec<_>>();
    let current_capacity = writer
        .lock()
        .map(|writer| writer.capacity())
        .unwrap_or_default();
    if meters.len() > current_capacity as usize {
        let Some(capacity) = u32::try_from(meters.len())
            .ok()
            .and_then(u32::checked_next_power_of_two)
        else {
            return;
        };
        let epoch = session_epoch.wrapping_add(page_epoch.fetch_add(1, Ordering::AcqRel) + 1);
        if let Ok(memory) = create_telemetry_page(capacity, epoch)
            && let Ok(next) = TelemetryWriter::map(memory.clone())
        {
            if let Ok(mut current) = writer.lock() {
                *current = next;
            }
            if let Ok(packet) = encode_event(
                &HostEvent::TelemetryPageOffer { epoch, capacity },
                vec![RegionOffer {
                    session_epoch,
                    region_id: 0,
                    region_generation: epoch,
                    capacity: memory.len() as u64,
                    memory,
                }],
            ) {
                let _ = outbound.send(OutboundMessage::Event(packet)).await;
            }
        }
    }
    let snapshot = TelemetrySnapshot {
        epoch: writer
            .lock()
            .map(|value| value.epoch())
            .unwrap_or(session_epoch),
        graph_revision,
        callback_generation,
        transport_state: transport_state_code(&transport_state),
        position_frames: transport.as_ref().map_or(0, |value| value.position_frames),
        sample_rate: transport.as_ref().map_or(0, |value| value.sample_rate),
        meters,
    };
    if let Ok(writer) = writer.lock() {
        let _ = writer.publish(&snapshot);
    }
}

fn validate_native_build_fingerprint(value: &str) -> Result<(), String> {
    if value == NATIVE_BUILD_FINGERPRINT {
        Ok(())
    } else {
        Err(format!(
            "audio-host native build mismatch: addon={value}, helper={NATIVE_BUILD_FINGERPRINT}"
        ))
    }
}

async fn run_protocol_actor(
    bootstrap: HostBootstrap,
    ui_proxy: EventLoopProxy<UiEvent>,
    ui_sender: std_mpsc::SyncSender<ActorRequest>,
    host_event_inbox: std_mpsc::Receiver<HostEvent>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    winit_generation: Arc<AtomicU64>,
    runtime_config: RuntimeConfig,
) -> Result<(), String> {
    const ACTOR_CAPACITY: usize = 64;
    const PROTOCOL_CAPACITY: usize = 256;
    let HostBootstrap {
        native_build_fingerprint,
        requests,
        responses,
        priority_requests,
        priority_responses,
        events,
        telemetry_page,
        parameter_ring,
        session_epoch,
    } = bootstrap;
    validate_native_build_fingerprint(&native_build_fingerprint)?;
    let telemetry = Arc::new(Mutex::new(
        TelemetryWriter::map(telemetry_page).map_err(|error| error.to_string())?,
    ));
    let parameter_consumer =
        ParameterConsumer::map(parameter_ring).map_err(|error| error.to_string())?;
    let response_leases = Arc::new(Mutex::new(LeaseRegistry::with_session_epoch(session_epoch)));
    let request_arena = Arc::new(Mutex::new(ArenaReceiver::new(session_epoch)));
    let ipc_generation = Arc::new(AtomicU64::new(0));
    let tokio_generation = Arc::new(AtomicU64::new(0));
    let published_event_revision = Arc::new(AtomicU64::new(0));
    let page_epoch = Arc::new(AtomicU64::new(0));
    let egress_metrics = Arc::new(EgressMetrics::default());
    let host_event_inbox = Arc::new(Mutex::new(host_event_inbox));

    let (outbound, outbound_inbox) = mpsc::channel(PROTOCOL_CAPACITY);
    let (egress_shutdown, egress_shutdown_rx) = watch::channel(false);
    let egress_task = tokio::spawn(run_egress(
        outbound_inbox,
        responses,
        events,
        EgressArenas {
            responses: response_leases.clone(),
            requests: request_arena.clone(),
        },
        runtime_config.egress_concurrency,
        egress_shutdown_rx,
        egress_metrics.clone(),
    ));
    let (inbound, mut inbound_inbox) = mpsc::channel(PROTOCOL_CAPACITY);
    let (priority, mut priority_inbox) = mpsc::channel(64);
    let ingress_thread = spawn_ingress(
        IngressChannels {
            requests,
            priority_requests,
            priority_responses,
        },
        IngressMailboxes {
            inbound,
            priority,
            outbound: outbound.clone(),
        },
        response_leases,
        request_arena.clone(),
        Liveness {
            ipc: ipc_generation.clone(),
            tokio: tokio_generation.clone(),
            winit: winit_generation,
            egress: egress_metrics,
        },
    );

    let handles = Arc::new(Mutex::new(GraphParameterHandles::default()));
    let (engine_sender, engine_inbox) = mpsc::channel(ACTOR_CAPACITY);
    let (vst3_sender, vst3_inbox) = mpsc::channel(ACTOR_CAPACITY);
    let (background_sender, background_inbox) = mpsc::channel(ACTOR_CAPACITY);
    tokio::spawn(engine_actor(engine_inbox, handles.clone()));
    tokio::task::spawn_local(vst3_actor(
        vst3_inbox,
        ui_proxy.clone(),
        ui_sender,
        processors,
        handles,
        request_arena.clone(),
    ));
    tokio::spawn(background_io_actor(background_inbox));

    outbound
        .send(OutboundMessage::Event(
            encode_event(&HostEvent::Ready, Vec::new()).map_err(|error| error.to_string())?,
        ))
        .await
        .map_err(|_| "audio-host egress stopped before Ready".to_owned())?;

    let telemetry_writer = telemetry.clone();
    let telemetry_outbound = outbound.clone();
    let telemetry_host_events = host_event_inbox.clone();
    let telemetry_event_revision = published_event_revision.clone();
    let telemetry_page_epoch = page_epoch.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(33));
        loop {
            interval.tick().await;
            let editor_events = telemetry_host_events
                .lock()
                .map(|inbox| inbox.try_iter().collect::<Vec<_>>())
                .unwrap_or_default();
            for event in editor_events {
                if let Ok(packet) = encode_event(&event, Vec::new()) {
                    let _ = telemetry_outbound
                        .send(OutboundMessage::Event(packet))
                        .await;
                }
            }
            let published_revision = engine::published_graph_generation();
            publish_telemetry(
                &telemetry_writer,
                &telemetry_outbound,
                published_revision,
                session_epoch,
                &telemetry_page_epoch,
            )
            .await;
            if published_revision != 0
                && telemetry_event_revision.swap(published_revision, Ordering::AcqRel)
                    != published_revision
                && let Ok(packet) = encode_event(
                    &HostEvent::GraphPublished {
                        revision: published_revision,
                    },
                    Vec::new(),
                )
            {
                let _ = telemetry_outbound
                    .send(OutboundMessage::Event(packet))
                    .await;
            }
        }
    });

    let shutting_down = Arc::new(AtomicBool::new(false));
    let inflight = Arc::new(Semaphore::new(PROTOCOL_CAPACITY));
    while !shutting_down.load(Ordering::Acquire) {
        tokio::select! {
            inbound = inbound_inbox.recv() => {
                let Some(inbound) = inbound else { break };
                tokio_generation.fetch_add(1, Ordering::Release);
                let permit = match inflight.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let _ = outbound
                            .send(OutboundMessage::Response {
                                value: response(
                                    inbound.request.request_id,
                                    ControlResult::Busy,
                                ),
                                request_leases: inbound.received_leases,
                            })
                            .await;
                        continue;
                    }
                };
                let engine_sender = engine_sender.clone();
                let vst3_sender = vst3_sender.clone();
                let background_sender = background_sender.clone();
                let outbound = outbound.clone();
                let ui_proxy = ui_proxy.clone();
                let shutting_down = shutting_down.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let ControlRequest {
                        request_id,
                        command,
                    } = inbound.request;
                    let received_leases = inbound.received_leases;
                    let shutdown = matches!(command, ControlCommand::Shutdown);
                    let deadline = protocol_deadline(&command);
                    let work = async move {
                        if shutdown {
                            let _ = engine::stop_audio_engine();
                            ControlResult::Accepted
                        } else {
                            match command {
                                ControlCommand::BenchmarkEcho { payload } => {
                                    ControlResult::BenchmarkEcho { payload }
                                }
                                command if is_vst3_command(&command) => {
                                    dispatch_actor(&vst3_sender, command).await
                                }
                                command if is_background_io_command(&command) => {
                                    dispatch_actor(&background_sender, command).await
                                }
                                command => dispatch_actor(&engine_sender, command).await,
                            }
                        }
                    };
                    let result = match tokio::time::timeout(deadline, work).await {
                        Ok(result) => result,
                        Err(_) => ControlResult::Error {
                            message: "audio-host request deadline exceeded".into(),
                        },
                    };
                    let _ = outbound
                        .send(OutboundMessage::Response {
                            value: response(request_id, result),
                            request_leases: received_leases,
                        })
                        .await;
                    if shutdown {
                        shutting_down.store(true, Ordering::Release);
                        let _ = ui_proxy.send_event(UiEvent::Exit);
                    }
                });
            }
            priority = priority_inbox.recv() => {
                let Some(priority) = priority else { break };
                tokio_generation.fetch_add(1, Ordering::Release);
                match priority {
                    PriorityIngress::ParameterWake => {
                        let mut commands = Vec::new();
                        parameter_consumer.drain(4096, &mut commands);
                        for command in commands {
                            let sender = match command.target_kind {
                                yadaw_dsp_runtime::protocol::ParameterTargetKind::Plugin => &vst3_sender,
                                _ => &engine_sender,
                            };
                            let _ = dispatch_parameter(sender, command).await;
                        }
                    }
                    PriorityIngress::ParameterBoundary(command) => {
                        let sender = match command.target_kind {
                            yadaw_dsp_runtime::protocol::ParameterTargetKind::Plugin => &vst3_sender,
                            _ => &engine_sender,
                        };
                        let _ = dispatch_parameter(sender, command).await;
                    }
                    PriorityIngress::Shutdown => {
                        let _ = engine::stop_audio_engine();
                        shutting_down.store(true, Ordering::Release);
                        let _ = ui_proxy.send_event(UiEvent::Exit);
                    }
                    PriorityIngress::TelemetryPageReady => {}
                }
            }
        }
    }
    // The blocking IPC receivers are deliberately detached. Joining them here would
    // deadlock a clean shutdown while the parent still owns channel handles. Process
    // teardown closes those handles after the Tokio actor and winit loop have exited.
    let final_editor_events = host_event_inbox
        .lock()
        .map(|inbox| inbox.try_iter().collect::<Vec<_>>())
        .unwrap_or_default();
    for event in final_editor_events {
        if let Ok(packet) = encode_event(&event, Vec::new()) {
            let _ = outbound.send(OutboundMessage::Event(packet)).await;
        }
    }
    let _ = egress_shutdown.send(true);
    let _ = egress_task.await;
    drop((outbound, ingress_thread));
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct RuntimeConfig {
    worker_threads: usize,
    max_blocking_threads: usize,
    egress_concurrency: usize,
}

impl RuntimeConfig {
    fn auto() -> Self {
        let logical = thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
        let worker_threads = logical.div_ceil(4).clamp(1, 4);
        let max_blocking_threads = (worker_threads * 2).clamp(2, 8);
        Self {
            worker_threads,
            max_blocking_threads,
            egress_concurrency: 2.min(max_blocking_threads),
        }
    }

    fn validate(self) -> Result<Self, String> {
        if !(1..=8).contains(&self.worker_threads) {
            return Err("worker threads must be between 1 and 8".into());
        }
        if !(2..=16).contains(&self.max_blocking_threads) {
            return Err("blocking threads must be between 2 and 16".into());
        }
        if !(1..=4).contains(&self.egress_concurrency)
            || self.egress_concurrency > self.max_blocking_threads
        {
            return Err(
                "egress concurrency must be between 1 and 4 and not exceed blocking threads".into(),
            );
        }
        Ok(self)
    }
}

enum UiEvent {
    Wake,
    Exit,
}

struct WinitHost {
    generation: Arc<AtomicU64>,
    proxy: EventLoopProxy<UiEvent>,
    inbox: std_mpsc::Receiver<ActorRequest>,
    processors: Arc<Mutex<HashMap<String, vst3::Vst3ProcessorHandle>>>,
    host_events: std_mpsc::SyncSender<HostEvent>,
    vst3: Option<vst3::Vst3Runtime>,
    compositor: TinySkiaCompositor,
    editor_owner_window: Option<usize>,
    editors: HashMap<WindowId, EditorWindow>,
    editor_instances: HashMap<String, WindowId>,
}

impl WinitHost {
    // VST3 controller calls must stay on this thread, but the same thread also
    // owns every native editor window. Bound each mailbox turn so plug-in code
    // cannot indefinitely delay the next platform-message dispatch.
    const UI_BATCH: usize = 4;
    const UI_BUDGET: std::time::Duration = std::time::Duration::from_millis(2);

    fn open_editor(
        &mut self,
        event_loop: &ActiveEventLoop,
        instance_id: String,
        preference: PluginEditorPreference,
    ) -> ControlResult {
        if !preference.is_valid() {
            return ControlResult::Error {
                message: "VST3 editor zoom is outside 50...400".into(),
            };
        }
        if let Some(window_id) = self.editor_instances.get(&instance_id).copied()
            && let Some(editor) = self.editors.get(&window_id)
        {
            editor.focus();
            return ControlResult::PluginEditor {
                active_mode: editor.active_mode(),
                open: true,
            };
        }
        let Some(runtime) = self.vst3.as_ref() else {
            return ControlResult::Error {
                message: "VST3 UI runtime is shutting down".into(),
            };
        };
        let Some(class_id) = runtime.class_id(&instance_id) else {
            return ControlResult::Error {
                message: "VST3 instance is not loaded".into(),
            };
        };
        let display_name = runtime
            .display_name(&instance_id)
            .unwrap_or("VST3 plug-in")
            .to_owned();
        let attributes = WindowAttributes::default()
            .with_title(format!("{display_name} — YADAW"))
            .with_inner_size(LogicalSize::new(720.0, 640.0));
        let attributes = configure_editor_window_attributes(attributes, self.editor_owner_window);
        let window = match event_loop.create_window(attributes) {
            Ok(window) => Arc::new(window),
            Err(error) => {
                return ControlResult::Error {
                    message: format!("could not create VST3 editor window: {error}"),
                };
            }
        };
        let window_id = window.id();
        let mut editor = EditorWindow::new(
            instance_id.clone(),
            class_id,
            preference,
            Vec::new(),
            window,
            &mut self.compositor,
        );
        editor.activate_initial_mode(runtime);
        let active_mode = editor.active_mode();
        self.editor_instances.insert(instance_id, window_id);
        self.editors.insert(window_id, editor);
        ControlResult::PluginEditor {
            active_mode,
            open: true,
        }
    }

    fn close_editor(&mut self, instance_id: &str) {
        let Some(window_id) = self.editor_instances.remove(instance_id) else {
            return;
        };
        if let Some(mut editor) = self.editors.remove(&window_id) {
            editor.close();
        }
    }

    fn execute_vst3_request(&mut self, event_loop: &ActiveEventLoop, request: ActorRequest) {
        let ActorRequest { command, reply } = request;
        let command = match command {
            ActorCommand::Control(ControlCommand::OpenPluginEditor {
                instance_id,
                preference,
            }) => {
                let _ = reply.send(self.open_editor(event_loop, instance_id, preference));
                return;
            }
            ActorCommand::Control(ControlCommand::ClosePluginEditor { instance_id }) => {
                self.close_editor(&instance_id);
                let _ = reply.send(ControlResult::Accepted);
                return;
            }
            ActorCommand::Control(ControlCommand::UnloadPlugin { instance_id }) => {
                self.close_editor(&instance_id);
                ActorCommand::Control(ControlCommand::UnloadPlugin { instance_id })
            }
            command => command,
        };
        let Some(runtime) = self.vst3.as_mut() else {
            let _ = reply.send(ControlResult::Error {
                message: "VST3 UI runtime is shutting down".into(),
            });
            return;
        };
        let result = match command {
            ActorCommand::Parameter(command) => runtime.apply_parameter_command(command),
            ActorCommand::Control(ControlCommand::Ping) => {
                for (instance_id, latency, tail) in runtime.take_timing_changes() {
                    if let Err(error) = engine::update_plugin_timing(&instance_id, latency, tail) {
                        eprintln!("audio-host: could not rebuild dynamic plugin latency: {error}");
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
            ActorCommand::Control(command) => {
                let loaded_id = match &command {
                    ControlCommand::LoadPlugin { instance_id, .. } => Some(instance_id.clone()),
                    _ => None,
                };
                let result = runtime.execute(command);
                if matches!(result, ControlResult::PluginLoaded { .. })
                    && let Some(instance_id) = loaded_id
                    && let Some(processor) = runtime.processor_handle(&instance_id)
                    && let Ok(mut processors) = self.processors.lock()
                {
                    processors.insert(instance_id, processor);
                }
                result
            }
        };
        let _ = reply.send(result);
    }

    fn drain_ui_mailbox(&mut self, event_loop: &ActiveEventLoop) {
        let started = std::time::Instant::now();
        let mut drained = 0;
        while should_drain_ui_request(drained, started.elapsed()) {
            match self.inbox.try_recv() {
                Ok(request) => {
                    self.execute_vst3_request(event_loop, request);
                    drained += 1;
                }
                Err(std_mpsc::TryRecvError::Empty) => return,
                Err(std_mpsc::TryRecvError::Disconnected) => return,
            }
        }
        let _ = self.proxy.send_event(UiEvent::Wake);
    }

    fn shutdown(&mut self) {
        self.editor_instances.clear();
        for (_, mut editor) in self.editors.drain() {
            editor.close();
        }
        if let Ok(mut processors) = self.processors.lock() {
            processors.clear();
        }
        self.vst3.take();
        while let Ok(request) = self.inbox.try_recv() {
            let _ = request.reply.send(ControlResult::Error {
                message: "VST3 UI runtime shut down".into(),
            });
        }
    }
}

fn should_drain_ui_request(drained: usize, elapsed: std::time::Duration) -> bool {
    drained < WinitHost::UI_BATCH && (drained == 0 || elapsed < WinitHost::UI_BUDGET)
}

impl ApplicationHandler<UiEvent> for WinitHost {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UiEvent) {
        self.generation.fetch_add(1, Ordering::Release);
        match event {
            UiEvent::Wake => self.drain_ui_mailbox(event_loop),
            UiEvent::Exit => {
                self.shutdown();
                event_loop.exit();
            }
        }
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if matches!(event, WindowEvent::RedrawRequested) {
            if let Some(editor) = self.editors.get_mut(&window_id) {
                editor.draw(&mut self.compositor);
            }
            return;
        }
        let actions = match self.editors.get_mut(&window_id) {
            Some(editor) => editor.handle_event(event, &mut self.compositor),
            None => return,
        };
        let mut close = false;
        for action in actions {
            if matches!(action, EditorAction::Close) {
                close = true;
                continue;
            }
            let (editors, runtime) = (&mut self.editors, &mut self.vst3);
            let (Some(editor), Some(runtime)) = (editors.get_mut(&window_id), runtime.as_mut())
            else {
                continue;
            };
            let class_id = editor.class_id.clone();
            if let Some(preference) = editor.apply_action(action, runtime) {
                let _ = self
                    .host_events
                    .try_send(HostEvent::PluginEditorPreferenceChanged {
                        class_id,
                        preference,
                    });
            }
        }
        if close
            && let Some(instance_id) = self
                .editors
                .get(&window_id)
                .map(|editor| editor.instance_id.clone())
        {
            self.close_editor(&instance_id);
        }
    }
}

fn configure_editor_window_attributes(
    attributes: WindowAttributes,
    _editor_owner_window: Option<usize>,
) -> WindowAttributes {
    #[cfg(target_os = "windows")]
    {
        use winit::platform::windows::WindowAttributesExtWindows;

        match _editor_owner_window {
            Some(owner) => attributes
                .with_owner_window(owner as isize)
                .with_skip_taskbar(true),
            None => attributes,
        }
    }

    #[cfg(target_os = "linux")]
    {
        use winit::platform::{wayland::WindowAttributesExtWayland, x11::WindowAttributesExtX11};

        let attributes =
            WindowAttributesExtX11::with_name(attributes, editor_platform::APPLICATION_ID, "yadaw");
        WindowAttributesExtWayland::with_name(attributes, editor_platform::APPLICATION_ID, "yadaw")
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    attributes
}

fn parse_editor_owner_window(value: &str) -> Result<usize, &'static str> {
    let handle = value
        .parse::<usize>()
        .map_err(|_| "invalid --editor-owner-window value")?;
    if handle == 0 {
        Err("--editor-owner-window must not be null")
    } else {
        Ok(handle)
    }
}

fn run_ipc() -> Result<(), Box<dyn std::error::Error>> {
    const UI_MAILBOX_CAPACITY: usize = 64;
    let mut arguments = env::args_os().skip(1);
    let mut ipc_token = None;
    let mut crash_marker_path = None;
    let mut editor_owner_window = None;
    let mut runtime_config = RuntimeConfig::auto();
    while let Some(argument) = arguments.next() {
        if argument == "--ipc-token" {
            ipc_token = arguments.next().and_then(|value| value.into_string().ok());
        } else if argument == "--crash-marker" {
            crash_marker_path = arguments.next().map(PathBuf::from);
        } else if argument == "--worker-threads" {
            runtime_config.worker_threads = arguments
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or("missing --worker-threads value")?
                .parse()?;
        } else if argument == "--max-blocking-threads" {
            runtime_config.max_blocking_threads = arguments
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or("missing --max-blocking-threads value")?
                .parse()?;
        } else if argument == "--egress-concurrency" {
            runtime_config.egress_concurrency = arguments
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or("missing --egress-concurrency value")?
                .parse()?;
        } else if argument == "--editor-owner-window" {
            editor_owner_window = Some(parse_editor_owner_window(
                &arguments
                    .next()
                    .and_then(|value| value.into_string().ok())
                    .ok_or("missing --editor-owner-window value")?,
            )?);
        }
    }
    let runtime_config = runtime_config.validate()?;
    // Complete the rendezvous before any platform or crash-marker setup that
    // can fail. AudioHostIpcClient constructs synchronously on Electron's main
    // thread; connecting first guarantees an early helper failure is observed
    // by its IPC routers instead of leaving the parent blocked in accept().
    let token = ipc_token.ok_or("missing --ipc-token")?;
    let rendezvous = IpcSender::<IpcSender<HostBootstrap>>::connect(token)?;
    let (bootstrap_sender, bootstrap_receiver) = ipc::channel::<HostBootstrap>()?;
    rendezvous.send(bootstrap_sender)?;

    editor_platform::configure_process_application_identity()
        .map_err(|error| format!("could not configure application identity: {error}"))?;
    // VSTGUI performs process-thread platform initialization from InitDll. On
    // Windows that includes COM-backed WIC creation, so OLE must already be
    // initialized before any plug-in module is loaded. Keep this guard alive
    // until after every editor, controller, and module owned below is dropped.
    let _native_ui_context = NativeUiContext::initialize()
        .map_err(|error| format!("could not initialize native UI context: {error}"))?;
    if let Some(path) = crash_marker_path.as_deref() {
        crash_marker::initialize(path)
            .map_err(|error| format!("could not initialize crash marker: {error}"))?;
    }
    let bootstrap = bootstrap_receiver.recv()?;

    let mut event_loop_builder = EventLoop::<UiEvent>::with_user_event();
    #[cfg(target_os = "macos")]
    event_loop_builder.with_activation_policy(ActivationPolicy::Accessory);
    let event_loop = event_loop_builder.build()?;
    let compositor = iced_tiny_skia::window::compositor::new(
        iced_tiny_skia::Settings::default(),
        event_loop.owned_display_handle(),
    );
    let proxy = event_loop.create_proxy();
    let application_proxy = proxy.clone();
    let (ui_sender, ui_inbox) = std_mpsc::sync_channel(UI_MAILBOX_CAPACITY);
    let (host_event_sender, host_event_inbox) = std_mpsc::sync_channel(UI_MAILBOX_CAPACITY);
    let processors = Arc::new(Mutex::new(HashMap::new()));
    let protocol_processors = processors.clone();
    let winit_generation = Arc::new(AtomicU64::new(0));
    let protocol_winit_generation = winit_generation.clone();
    let protocol_thread = thread::Builder::new()
        .name("yadaw-control".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(runtime_config.worker_threads)
                .max_blocking_threads(runtime_config.max_blocking_threads)
                .thread_name("yadaw-tokio")
                .enable_all()
                .build()
                .expect("multi-thread Tokio runtime must start");
            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, async move {
                if let Err(error) = run_protocol_actor(
                    bootstrap,
                    proxy.clone(),
                    ui_sender,
                    host_event_inbox,
                    protocol_processors,
                    protocol_winit_generation,
                    runtime_config,
                )
                .await
                {
                    eprintln!("audio-host: protocol actor stopped: {error}");
                    let _ = proxy.send_event(UiEvent::Exit);
                }
            });
        })?;
    let mut application = WinitHost {
        generation: winit_generation,
        proxy: application_proxy,
        inbox: ui_inbox,
        processors,
        host_events: host_event_sender,
        vst3: Some(vst3::Vst3Runtime::new()),
        compositor,
        editor_owner_window,
        editors: HashMap::new(),
        editor_instances: HashMap::new(),
    };
    event_loop.run_app(&mut application)?;
    protocol_thread
        .join()
        .map_err(|_| "audio-host protocol thread panicked")?;
    Ok(())
}

fn main() -> ExitCode {
    let uses_ipc = env::args_os().any(|argument| argument == "--ipc-token");
    let result = if uses_ipc { run_ipc() } else { run_legacy() };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("audio-host: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_rejects_a_stale_native_build() {
        assert!(validate_native_build_fingerprint(NATIVE_BUILD_FINGERPRINT).is_ok());
        assert!(validate_native_build_fingerprint("stale-build").is_err());
    }

    #[test]
    fn editor_owner_window_rejects_null_and_invalid_handles() {
        assert_eq!(parse_editor_owner_window("4660"), Ok(4660));
        assert!(parse_editor_owner_window("0").is_err());
        assert!(parse_editor_owner_window("not-a-handle").is_err());
    }

    #[test]
    fn ui_mailbox_always_services_one_request_but_respects_fairness_limits() {
        assert!(should_drain_ui_request(
            0,
            WinitHost::UI_BUDGET.saturating_mul(10)
        ));
        assert!(should_drain_ui_request(
            WinitHost::UI_BATCH - 1,
            WinitHost::UI_BUDGET.saturating_sub(std::time::Duration::from_nanos(1))
        ));
        assert!(!should_drain_ui_request(1, WinitHost::UI_BUDGET));
        assert!(!should_drain_ui_request(
            WinitHost::UI_BATCH,
            std::time::Duration::ZERO
        ));
    }
}
