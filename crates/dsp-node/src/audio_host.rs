use std::{mem::size_of, sync::Arc};

use heron_audio_host::runtime::embedded::{
    EmbeddedAudioHost, EmbeddedEditorHostRegistration, EmbeddedParameterEnqueue,
    EmbeddedRuntimeConfig, EmbeddedRuntimeError, EmbeddedUiWake,
};
use heron_dsp_runtime::protocol::{
    ControlRequest, ParameterCommand, ParameterGesture, ParameterTargetKind, PriorityRequest,
};
use napi::{
    Error, Result, Status,
    bindgen_prelude::{Buffer, Function},
    threadsafe_function::{ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;

fn failure(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn runtime_failure(error: EmbeddedRuntimeError) -> Error {
    failure("embedded audio runtime", error)
}

fn decode_native_window_handle(handle: Option<&[u8]>) -> Result<Option<usize>> {
    let Some(handle) = handle else {
        return Ok(None);
    };
    if handle.len() != size_of::<usize>() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "invalid editor owner window handle: expected {} bytes, received {}",
                size_of::<usize>(),
                handle.len()
            ),
        ));
    }
    let bytes: [u8; size_of::<usize>()] = handle.try_into().map_err(|_| {
        Error::new(
            Status::InvalidArg,
            "invalid editor owner window handle byte length",
        )
    })?;
    let value = usize::from_ne_bytes(bytes);
    if value == 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "editor owner window handle is null",
        ));
    }
    Ok(Some(value))
}

fn parse_gesture(value: &str) -> Result<ParameterGesture> {
    match value {
        "begin" => Ok(ParameterGesture::Begin),
        "perform" => Ok(ParameterGesture::Perform),
        "end" => Ok(ParameterGesture::End),
        _ => Err(Error::new(Status::InvalidArg, "invalid parameter gesture")),
    }
}

#[napi(object)]
pub struct NativeHostResponse {
    pub body: Buffer,
    pub attachments: Vec<Buffer>,
}

#[napi(object)]
pub struct ParameterEnqueueResult {
    pub outcome: String,
    pub sequence: String,
}

#[napi(object)]
pub struct ParameterEnqueueRequest {
    pub target_kind: String,
    pub runtime_handle: u32,
    pub parameter_id: u32,
    pub normalized: f64,
    pub gesture: String,
    pub sequence: Option<String>,
    pub target_generation: Option<u32>,
}

#[napi(object)]
pub struct EditorHostRegistrationRequest {
    pub instance_id: String,
    pub parent_window_handle: Buffer,
    pub width: u32,
    pub height: u32,
    pub top_inset: u32,
    pub display_scale: f64,
}

#[napi(object)]
pub struct EditorHostResizeRequest {
    pub instance_id: String,
    pub width: u32,
    pub height: u32,
    pub top_inset: u32,
    pub display_scale: f64,
}

#[napi(object)]
pub struct NativeEditorHostSnapshot {
    pub instance_id: String,
    pub width: u32,
    pub height: u32,
    pub display_scale: f64,
    pub resizable: bool,
    pub attached: bool,
}

#[napi(object)]
pub struct NativeEditorHostEvent {
    pub instance_id: String,
    pub width: u32,
    pub height: u32,
    pub resizable: bool,
}

#[napi(object)]
pub struct NativeEditorToolbarState {
    pub active_mode: String,
    pub zoom_percent: u16,
    pub compare_slot: String,
    pub can_compare: bool,
    pub can_paste: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub sidechain_buses: Vec<NativeEditorSidechainBus>,
    pub sidechain_sources: Vec<NativeEditorSidechainSource>,
    pub sidechain_pending: bool,
}

#[napi(object)]
pub struct NativeEditorSidechainBus {
    pub input_bus_index: u32,
    pub name: String,
    pub source_channel_id: Option<String>,
}

#[napi(object)]
pub struct NativeEditorSidechainSource {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[napi]
pub struct AudioHostRuntime {
    runtime: EmbeddedAudioHost,
}

#[napi]
impl AudioHostRuntime {
    #[napi(constructor)]
    pub fn new(
        worker_threads: Option<u32>,
        max_blocking_threads: Option<u32>,
        editor_owner_window_handle: Option<Buffer>,
        ui_wake_callback: Option<Function<'_, (), UnknownReturnValue>>,
    ) -> Result<Self> {
        let defaults = EmbeddedRuntimeConfig::auto();
        let config = EmbeddedRuntimeConfig {
            worker_threads: worker_threads.map_or(defaults.worker_threads, |value| value as usize),
            max_blocking_threads: max_blocking_threads
                .map_or(defaults.max_blocking_threads, |value| value as usize),
        };
        let editor_owner_window =
            decode_native_window_handle(editor_owner_window_handle.as_deref())?;
        let ui_wake = ui_wake_callback
            .map(|callback| {
                let callback = callback
                    .build_threadsafe_function::<()>()
                    .callee_handled::<false>()
                    .weak::<true>()
                    .max_queue_size::<1>()
                    .build()?;
                Ok::<EmbeddedUiWake, Error>(Arc::new(move || {
                    let _ = callback.call((), ThreadsafeFunctionCallMode::NonBlocking);
                }))
            })
            .transpose()?;
        let runtime = EmbeddedAudioHost::start(config, editor_owner_window, ui_wake)
            .map_err(runtime_failure)?;
        Ok(Self { runtime })
    }

    #[napi]
    pub async fn request(
        &self,
        message_pack_request: Buffer,
        attachments: Option<Vec<Buffer>>,
    ) -> Result<NativeHostResponse> {
        if attachments
            .as_ref()
            .is_some_and(|values| !values.is_empty())
        {
            return Err(Error::new(
                Status::InvalidArg,
                "embedded audio requests must carry inline binary payloads",
            ));
        }
        let request = rmp_serde::from_slice::<ControlRequest>(&message_pack_request)
            .map_err(|error| failure("invalid embedded audio request", error))?;
        let response = self
            .runtime
            .request(request)
            .await
            .map_err(runtime_failure)?;
        let body = rmp_serde::to_vec_named(&response)
            .map_err(|error| failure("could not encode embedded audio response", error))?;
        Ok(NativeHostResponse {
            body: body.into(),
            attachments: Vec::new(),
        })
    }

    #[napi]
    pub async fn heartbeat(&self, message_pack_request: Buffer) -> Result<NativeHostResponse> {
        let request = rmp_serde::from_slice::<PriorityRequest>(&message_pack_request)
            .map_err(|error| failure("invalid embedded heartbeat request", error))?;
        let response = self.runtime.priority(request).map_err(runtime_failure)?;
        let body = rmp_serde::to_vec_named(&response)
            .map_err(|error| failure("could not encode embedded priority response", error))?;
        Ok(NativeHostResponse {
            body: body.into(),
            attachments: Vec::new(),
        })
    }

    #[napi]
    pub fn drain_ui_work(&self) -> Result<bool> {
        self.runtime.drain_ui_work().map_err(runtime_failure)
    }

    #[napi]
    pub fn register_editor_host(&self, request: EditorHostRegistrationRequest) -> Result<()> {
        let parent_window = decode_native_window_handle(Some(&request.parent_window_handle))?
            .ok_or_else(|| Error::new(Status::InvalidArg, "editor parent handle is required"))?;
        unsafe {
            // SAFETY: Electron owns this live BaseWindow on the calling main thread. The
            // TypeScript editor manager unregisters it before destroying the window.
            self.runtime
                .register_editor_host(EmbeddedEditorHostRegistration {
                    instance_id: request.instance_id,
                    parent_window,
                    width: request.width,
                    height: request.height,
                    top_inset: request.top_inset,
                    display_scale: request.display_scale,
                })
        }
        .map_err(runtime_failure)
    }

    #[napi]
    pub fn resize_editor_host(&self, request: EditorHostResizeRequest) -> Result<()> {
        self.runtime
            .resize_editor_host(
                &request.instance_id,
                request.width,
                request.height,
                request.top_inset,
                request.display_scale,
            )
            .map_err(runtime_failure)
    }

    #[napi]
    pub fn unregister_editor_host(&self, instance_id: String) {
        self.runtime.unregister_editor_host(&instance_id);
    }

    #[napi]
    pub fn editor_host_snapshot(&self, instance_id: String) -> Option<NativeEditorHostSnapshot> {
        self.runtime
            .editor_host_snapshot(&instance_id)
            .map(|snapshot| NativeEditorHostSnapshot {
                instance_id: snapshot.instance_id,
                width: snapshot.width,
                height: snapshot.height,
                display_scale: snapshot.display_scale,
                resizable: snapshot.resizable,
                attached: snapshot.attached,
            })
    }

    #[napi]
    pub fn focus_editor_host(&self, instance_id: String) -> bool {
        self.runtime.focus_editor_host(&instance_id)
    }

    #[napi]
    pub fn drain_editor_host_events(&self) -> Vec<NativeEditorHostEvent> {
        self.runtime
            .drain_editor_host_events()
            .into_iter()
            .map(|event| NativeEditorHostEvent {
                instance_id: event.instance_id,
                width: event.width,
                height: event.height,
                resizable: event.resizable,
            })
            .collect()
    }

    #[napi]
    pub fn editor_toolbar_state(&self, instance_id: String) -> Option<NativeEditorToolbarState> {
        self.runtime
            .editor_toolbar_state(&instance_id)
            .map(native_toolbar_state)
    }

    #[napi]
    pub fn read_telemetry(&self) -> Result<Buffer> {
        let snapshot = self.runtime.telemetry();
        rmp_serde::to_vec_named(&(
            snapshot.epoch,
            snapshot.graph_revision,
            snapshot.callback_generation,
            snapshot.transport_state,
            snapshot.position_frames,
            snapshot.sample_rate,
            snapshot
                .meters
                .into_iter()
                .map(|meter| {
                    (
                        meter.runtime_handle,
                        meter.pre_left,
                        meter.pre_right,
                        meter.post_left,
                        meter.post_right,
                        meter.held_left,
                        meter.held_right,
                        meter.clipped,
                    )
                })
                .collect::<Vec<_>>(),
        ))
        .map(Buffer::from)
        .map_err(|error| failure("could not encode embedded telemetry", error))
    }

    #[napi]
    pub fn enqueue_parameter(
        &self,
        request: ParameterEnqueueRequest,
    ) -> Result<ParameterEnqueueResult> {
        let target_kind = match request.target_kind.as_str() {
            "plugin" => ParameterTargetKind::Plugin,
            "mixer-channel" => ParameterTargetKind::MixerChannel,
            "mixer-send" => ParameterTargetKind::MixerSend,
            _ => {
                return Err(Error::new(Status::InvalidArg, "invalid parameter target"));
            }
        };
        let sequence = request.sequence.map_or_else(
            || Ok(self.runtime.next_parameter_sequence()),
            |value| {
                value
                    .parse::<u64>()
                    .map_err(|error| failure("invalid parameter sequence", error))
            },
        )?;
        let command = ParameterCommand {
            session_epoch: self.runtime.session_epoch(),
            sequence,
            target_kind,
            runtime_handle: request.runtime_handle,
            parameter_id: request.parameter_id,
            normalized: request.normalized,
            target_generation: request.target_generation.unwrap_or(0),
            gesture: parse_gesture(&request.gesture)?,
        };
        let outcome = match self.runtime.enqueue_parameter(command) {
            EmbeddedParameterEnqueue::Queued => "queued",
            EmbeddedParameterEnqueue::Full => "full",
            EmbeddedParameterEnqueue::StaleEpoch => "stale",
        };
        Ok(ParameterEnqueueResult {
            outcome: outcome.to_owned(),
            sequence: sequence.to_string(),
        })
    }

    #[napi]
    pub fn transport_diagnostics(&self) -> Result<Buffer> {
        let telemetry = self.runtime.telemetry();
        let config = self.runtime.resolved_config();
        rmp_serde::to_vec_named(&(
            self.runtime.session_epoch().to_string(),
            (
                self.runtime.pending_requests(),
                256_u32,
                self.runtime.slow_requests(),
            ),
            0_u32,
            (
                self.runtime.session_epoch().to_string(),
                telemetry.graph_revision,
                telemetry.callback_generation,
                telemetry.meters.len(),
            ),
            (
                256_u32,
                self.runtime.parameter_full(),
                self.runtime.parameter_stale(),
            ),
            (config.worker_threads, config.max_blocking_threads),
        ))
        .map(Buffer::from)
        .map_err(|error| failure("could not encode embedded diagnostics", error))
    }

    #[napi(getter)]
    pub fn session_epoch(&self) -> i64 {
        self.runtime.session_epoch() as i64
    }

    #[napi(getter)]
    pub fn runtime_epoch(&self) -> String {
        self.runtime.session_epoch().to_string()
    }

    #[napi(getter)]
    pub fn direct_telemetry(&self) -> bool {
        true
    }

    #[napi]
    pub fn drain_events(&self) -> Result<Vec<Buffer>> {
        self.runtime
            .drain_events()
            .into_iter()
            .map(|event| {
                rmp_serde::to_vec_named(&event)
                    .map(Buffer::from)
                    .map_err(|error| failure("could not encode embedded host event", error))
            })
            .collect()
    }

    #[napi]
    pub fn close(&self) {
        self.runtime.close();
    }
}

fn native_toolbar_state(
    state: heron_dsp_runtime::protocol::PluginEditorToolbarState,
) -> NativeEditorToolbarState {
    NativeEditorToolbarState {
        active_mode: match state.active_mode {
            heron_dsp_runtime::protocol::PluginEditorMode::Native => "native",
            heron_dsp_runtime::protocol::PluginEditorMode::Parameters => "parameters",
        }
        .to_owned(),
        zoom_percent: state.zoom_percent,
        compare_slot: match state.compare_slot {
            heron_dsp_runtime::protocol::PluginEditorCompareSlot::A => "a",
            heron_dsp_runtime::protocol::PluginEditorCompareSlot::B => "b",
        }
        .to_owned(),
        can_compare: state.can_compare,
        can_paste: state.can_paste,
        can_undo: state.can_undo,
        can_redo: state.can_redo,
        sidechain_buses: state
            .sidechain_buses
            .into_iter()
            .map(|bus| NativeEditorSidechainBus {
                input_bus_index: bus.input_bus_index,
                name: bus.name,
                source_channel_id: bus.source_channel_id,
            })
            .collect(),
        sidechain_sources: state
            .sidechain_sources
            .into_iter()
            .map(|source| NativeEditorSidechainSource {
                id: source.id,
                name: source.name,
                kind: match source.kind {
                    heron_dsp_runtime::protocol::PluginEditorSidechainSourceKind::Audio => "audio",
                    heron_dsp_runtime::protocol::PluginEditorSidechainSourceKind::Instrument => {
                        "instrument"
                    }
                    heron_dsp_runtime::protocol::PluginEditorSidechainSourceKind::Aux => "aux",
                }
                .to_owned(),
            })
            .collect(),
        sidechain_pending: state.sidechain_pending,
    }
}

impl Drop for AudioHostRuntime {
    fn drop(&mut self) {
        self.runtime.close();
    }
}
