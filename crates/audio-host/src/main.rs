use std::{
    env,
    io::{self, BufReader, BufWriter},
    path::PathBuf,
    process::ExitCode,
    thread,
};

use futures_util::StreamExt;
use ipc_channel::ipc::{self, IpcSender};
use tokio::sync::{mpsc, oneshot};
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    window::WindowId,
};
use yadaw_audio_host::{
    crash_marker, device, engine,
    recording::{NativeRecordingResult, NativeRecordingStartConfig, NativeWaveformSnapshot},
    vst3,
};
use yadaw_dsp_runtime::protocol::{
    AudioBackend, AudioDevice, AudioDeviceList, AudioRuntime, ControlCommand, ControlRequest,
    ControlResponse, ControlResult, HostBootstrap, HostEvent, LiveMixerGraph, MixerChannelMeter,
    PROTOCOL_VERSION, RecordingResult, RecordingWaveform, TransportState, read_message,
    validate_version, write_message,
};
use yadaw_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};

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
    value: LiveMixerGraph,
    vst3: Option<&vst3::Vst3Runtime>,
) -> engine::NativeMixerGraph {
    engine::NativeMixerGraph {
        generation,
        sample_rate: value.sample_rate,
        channels: value
            .channels
            .into_iter()
            .map(|channel| engine::NativeMixerChannel {
                id: channel.id,
                kind: channel.kind,
                gain_db: channel.gain_db,
                pan: channel.pan,
                muted: channel.muted,
                soloed: channel.soloed,
                output_index: channel.output_index,
                record_armed: channel.record_armed,
                input_channels: channel.input_channels,
                hardware_output_channels: channel.hardware_output_channels,
            })
            .collect(),
        sends: value
            .sends
            .into_iter()
            .map(|send| engine::NativeMixerSend {
                id: send.id,
                source_index: send.source_index,
                target_index: send.target_index,
                enabled: send.enabled,
                tap: send.tap,
                level_db: send.level_db,
                pan: send.pan,
            })
            .collect(),
        clips: value
            .clips
            .into_iter()
            .map(|clip| engine::NativeMixerClip {
                id: clip.id,
                channel_index: clip.channel_index,
                start_frame: clip.start_frame,
                source_offset_frames: clip.source_offset_frames,
                length_frames: clip.length_frames,
                path: clip.path,
            })
            .collect(),
        plugins: value
            .plugins
            .into_iter()
            .map(|plugin| engine::NativePluginInstance {
                processor: vst3.and_then(|runtime| runtime.processor_handle(&plugin.instance_id)),
                instance_id: plugin.instance_id,
                channel_index: plugin.channel_index,
                role: plugin.role,
                slot_order: plugin.slot_order,
                enabled: plugin.enabled,
                latency_samples: plugin.latency_samples,
                tail_samples: plugin.tail_samples,
            })
            .collect(),
        midi_clips: value
            .midi_clips
            .into_iter()
            .map(|clip| engine::NativeMidiClip {
                id: clip.id,
                channel_index: clip.channel_index,
                start_tick: clip.start_tick,
                source_offset_ticks: clip.source_offset_ticks,
                length_ticks: clip.length_ticks,
                notes: clip
                    .notes
                    .into_iter()
                    .map(|note| engine::NativeMidiNote {
                        start_tick: note.start_tick,
                        duration_ticks: note.duration_ticks,
                        channel: note.channel,
                        key: note.key,
                        velocity: note.velocity,
                        release_velocity: note.release_velocity,
                    })
                    .collect(),
            })
            .collect(),
        tempo_events: value
            .tempo_events
            .into_iter()
            .map(|event| TempoEvent {
                tick: event.tick,
                beats_per_minute: event.beats_per_minute,
            })
            .collect(),
        time_signature_events: value
            .time_signature_events
            .into_iter()
            .map(|event| TimeSignatureEvent {
                tick: event.tick,
                numerator: event.numerator,
                denominator: event.denominator,
            })
            .collect(),
    }
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
        peaks: value.peaks,
    }
}

fn engine_command(
    command: ControlCommand,
    vst3: Option<&vst3::Vst3Runtime>,
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
        ControlCommand::LoadGraph { revision, graph } => {
            match engine::load_mixer_graph(live_graph(revision, graph, vst3)) {
                Ok(()) => ControlResult::Accepted,
                Err(error) => ControlResult::Error {
                    message: error.to_string(),
                },
            }
        }
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
    let mut bridge_path: Option<PathBuf> = None;
    let mut crash_marker_path: Option<PathBuf> = None;
    while let Some(argument) = arguments.next() {
        if argument == "--vst3-bridge" {
            bridge_path = arguments.next().map(PathBuf::from);
        } else if argument == "--crash-marker" {
            crash_marker_path = arguments.next().map(PathBuf::from);
        }
    }
    if let Some(path) = crash_marker_path.as_deref() {
        crash_marker::initialize(path)
            .map_err(|error| format!("could not initialize crash marker: {error}"))?;
    }
    let mut vst3 = bridge_path
        .as_deref()
        .map(vst3::Vst3Runtime::load)
        .transpose()
        .map_err(|error| format!("could not load VST3 bridge: {error}"))?;
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    loop {
        let request: ControlRequest = read_message(&mut input)?;
        let result = match validate_version(request.version) {
            Ok(()) => match request.command {
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
                        message: "VST3 bridge is not configured".into(),
                    },
                },
                ControlCommand::Shutdown => {
                    let _ = engine::stop_audio_engine();
                    write_message(
                        &mut output,
                        &ControlResponse {
                            version: PROTOCOL_VERSION,
                            request_id: request.request_id,
                            result: ControlResult::Accepted,
                        },
                    )?;
                    return Ok(());
                }
                command => match engine_command(command, vst3.as_ref()) {
                    Some(result) => result,
                    None => ControlResult::Error {
                        message: "unsupported audio-host command".into(),
                    },
                },
            },
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
        };
        if let Some(runtime) = vst3.as_ref() {
            runtime.pump_editor_events();
        }
        write_message(
            &mut output,
            &ControlResponse {
                version: PROTOCOL_VERSION,
                request_id: request.request_id,
                result,
            },
        )?;
    }
}

struct ActorRequest {
    command: ControlCommand,
    reply: oneshot::Sender<ControlResult>,
}

async fn engine_actor(mut inbox: mpsc::Receiver<ActorRequest>) {
    while let Some(message) = inbox.recv().await {
        let result = engine_command(message.command, None).unwrap_or(ControlResult::Error {
            message: "unsupported engine command".into(),
        });
        let _ = message.reply.send(result);
    }
}

async fn background_io_actor(mut inbox: mpsc::Receiver<ActorRequest>) {
    while let Some(message) = inbox.recv().await {
        let result = engine_command(message.command, None).unwrap_or(ControlResult::Error {
            message: "unsupported background I/O command".into(),
        });
        let _ = message.reply.send(result);
    }
}

async fn vst3_actor(
    mut inbox: mpsc::Receiver<ActorRequest>,
    bridge_path: Option<PathBuf>,
    ui_proxy: EventLoopProxy<UiEvent>,
) {
    let mut runtime = match bridge_path
        .as_deref()
        .map(vst3::Vst3Runtime::load)
        .transpose()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("audio-host: could not load transitional VST3 runtime: {error}");
            None
        }
    };
    while let Some(message) = inbox.recv().await {
        let result = match message.command {
            ControlCommand::Ping => {
                if let Some(runtime) = runtime.as_ref() {
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
            | ControlCommand::ClosePluginEditor { .. }) => match runtime.as_mut() {
                Some(runtime) => runtime.execute(command),
                None => ControlResult::Error {
                    message: "VST3 runtime is not configured".into(),
                },
            },
            command @ ControlCommand::LoadGraph { .. } => engine_command(command, runtime.as_ref())
                .unwrap_or(ControlResult::Error {
                    message: "could not compile mixer graph".into(),
                }),
            _ => ControlResult::Error {
                message: "unsupported VST3 actor command".into(),
            },
        };
        if let Some(runtime) = runtime.as_ref() {
            runtime.pump_editor_events();
        }
        let _ = ui_proxy.send_event(UiEvent::Wake);
        let _ = message.reply.send(result);
    }
}

async fn dispatch_actor(
    sender: &mpsc::Sender<ActorRequest>,
    command: ControlCommand,
) -> ControlResult {
    let (reply, response) = oneshot::channel();
    if sender.send(ActorRequest { command, reply }).await.is_err() {
        return ControlResult::Error {
            message: "audio-host actor stopped".into(),
        };
    }
    response.await.unwrap_or(ControlResult::Error {
        message: "audio-host actor dropped its response".into(),
    })
}

fn is_vst3_command(command: &ControlCommand) -> bool {
    matches!(
        command,
        ControlCommand::Ping
            | ControlCommand::LoadGraph { .. }
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

async fn run_protocol_actor(
    bootstrap: HostBootstrap,
    bridge_path: Option<PathBuf>,
    ui_proxy: EventLoopProxy<UiEvent>,
) -> Result<(), String> {
    const ACTOR_CAPACITY: usize = 64;
    let (engine_sender, engine_inbox) = mpsc::channel(ACTOR_CAPACITY);
    let (vst3_sender, vst3_inbox) = mpsc::channel(ACTOR_CAPACITY);
    let (background_sender, background_inbox) = mpsc::channel(ACTOR_CAPACITY);
    tokio::task::spawn_local(engine_actor(engine_inbox));
    tokio::task::spawn_local(vst3_actor(vst3_inbox, bridge_path, ui_proxy.clone()));
    tokio::task::spawn_local(background_io_actor(background_inbox));

    bootstrap
        .events
        .send(rmp_serde::to_vec_named(&HostEvent::Ready).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let mut requests = bootstrap.requests.to_stream();
    while let Some(message) = requests.next().await {
        let payload = message.map_err(|error| error.to_string())?;
        if payload.len() > yadaw_dsp_runtime::protocol::MAX_MESSAGE_BYTES {
            return Err("audio-host IPC request exceeds 64 MiB".into());
        }
        let request: ControlRequest =
            rmp_serde::from_slice(&payload).map_err(|error| error.to_string())?;
        let shutdown = matches!(request.command, ControlCommand::Shutdown);
        let result = match validate_version(request.version) {
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
            Ok(()) if shutdown => {
                let _ = engine::stop_audio_engine();
                ControlResult::Accepted
            }
            Ok(()) if is_vst3_command(&request.command) => {
                dispatch_actor(&vst3_sender, request.command).await
            }
            Ok(()) if is_background_io_command(&request.command) => {
                dispatch_actor(&background_sender, request.command).await
            }
            Ok(()) => dispatch_actor(&engine_sender, request.command).await,
        };
        let response = ControlResponse {
            version: PROTOCOL_VERSION,
            request_id: request.request_id,
            result,
        };
        bootstrap
            .responses
            .send(rmp_serde::to_vec_named(&response).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        if shutdown {
            let _ = ui_proxy.send_event(UiEvent::Exit);
            break;
        }
    }
    Ok(())
}

enum UiEvent {
    Wake,
    Exit,
}

#[derive(Default)]
struct WinitHost;

impl ApplicationHandler<UiEvent> for WinitHost {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UiEvent) {
        if matches!(event, UiEvent::Exit) {
            event_loop.exit();
        }
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        _event: WindowEvent,
    ) {
    }
}

fn run_ipc() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let mut ipc_token = None;
    let mut bridge_path = None;
    let mut crash_marker_path = None;
    while let Some(argument) = arguments.next() {
        if argument == "--ipc-token" {
            ipc_token = arguments.next().and_then(|value| value.into_string().ok());
        } else if argument == "--vst3-bridge" {
            bridge_path = arguments.next().map(PathBuf::from);
        } else if argument == "--crash-marker" {
            crash_marker_path = arguments.next().map(PathBuf::from);
        }
    }
    if let Some(path) = crash_marker_path.as_deref() {
        crash_marker::initialize(path)
            .map_err(|error| format!("could not initialize crash marker: {error}"))?;
    }
    let token = ipc_token.ok_or("missing --ipc-token")?;
    let rendezvous = IpcSender::<IpcSender<HostBootstrap>>::connect(token)?;
    let (bootstrap_sender, bootstrap_receiver) = ipc::channel::<HostBootstrap>()?;
    rendezvous.send(bootstrap_sender)?;
    let bootstrap = bootstrap_receiver.recv()?;

    let event_loop = EventLoop::<UiEvent>::with_user_event().build()?;
    let proxy = event_loop.create_proxy();
    let protocol_thread = thread::Builder::new()
        .name("yadaw-control".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("single-thread Tokio runtime must start");
            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, async move {
                if let Err(error) = run_protocol_actor(bootstrap, bridge_path, proxy.clone()).await
                {
                    eprintln!("audio-host: protocol actor stopped: {error}");
                    let _ = proxy.send_event(UiEvent::Exit);
                }
            });
        })?;
    let mut application = WinitHost;
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
