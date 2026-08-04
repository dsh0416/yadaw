use std::mem::size_of;

use heron_audio_host::runtime::embedded::{
    EmbeddedAudioHost, EmbeddedParameterEnqueue, EmbeddedRuntimeConfig, EmbeddedRuntimeError,
};
use heron_dsp_runtime::protocol::{
    ControlRequest, ParameterCommand, ParameterGesture, ParameterTargetKind, PriorityRequest,
};
use napi::{
    Error, Result, Status, Task,
    bindgen_prelude::{AsyncTask, Buffer},
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

pub struct OwnedHostResponse {
    body: Vec<u8>,
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

pub struct HostRequestTask {
    runtime: EmbeddedAudioHost,
    request: ControlRequest,
}

#[napi]
impl Task for HostRequestTask {
    type Output = OwnedHostResponse;
    type JsValue = NativeHostResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        let response = self
            .runtime
            .request(self.request.clone())
            .map_err(runtime_failure)?;
        let body = rmp_serde::to_vec_named(&response)
            .map_err(|error| failure("could not encode embedded audio response", error))?;
        Ok(OwnedHostResponse { body })
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(NativeHostResponse {
            body: output.body.into(),
            attachments: Vec::new(),
        })
    }
}

pub struct HostPriorityTask {
    runtime: EmbeddedAudioHost,
    request: PriorityRequest,
}

#[napi]
impl Task for HostPriorityTask {
    type Output = OwnedHostResponse;
    type JsValue = NativeHostResponse;

    fn compute(&mut self) -> Result<Self::Output> {
        let response = self
            .runtime
            .priority(self.request.clone())
            .map_err(runtime_failure)?;
        let body = rmp_serde::to_vec_named(&response)
            .map_err(|error| failure("could not encode embedded priority response", error))?;
        Ok(OwnedHostResponse { body })
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(NativeHostResponse {
            body: output.body.into(),
            attachments: Vec::new(),
        })
    }
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
    ) -> Result<Self> {
        let defaults = EmbeddedRuntimeConfig::auto();
        let config = EmbeddedRuntimeConfig {
            worker_threads: worker_threads.map_or(defaults.worker_threads, |value| value as usize),
            max_blocking_threads: max_blocking_threads
                .map_or(defaults.max_blocking_threads, |value| value as usize),
        };
        let editor_owner_window =
            decode_native_window_handle(editor_owner_window_handle.as_deref())?;
        let runtime =
            EmbeddedAudioHost::start(config, editor_owner_window).map_err(runtime_failure)?;
        Ok(Self { runtime })
    }

    #[napi]
    pub fn request(
        &self,
        message_pack_request: Buffer,
        attachments: Option<Vec<Buffer>>,
    ) -> Result<AsyncTask<HostRequestTask>> {
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
        Ok(AsyncTask::new(HostRequestTask {
            runtime: self.runtime.clone(),
            request,
        }))
    }

    #[napi]
    pub fn heartbeat(&self, message_pack_request: Buffer) -> Result<AsyncTask<HostPriorityTask>> {
        let request = rmp_serde::from_slice::<PriorityRequest>(&message_pack_request)
            .map_err(|error| failure("invalid embedded heartbeat request", error))?;
        Ok(AsyncTask::new(HostPriorityTask {
            runtime: self.runtime.clone(),
            request,
        }))
    }

    #[napi]
    pub fn pump_events(&self) -> Result<()> {
        self.runtime.pump_events().map_err(runtime_failure)
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
                self.runtime.request_timeouts(),
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

impl Drop for AudioHostRuntime {
    fn drop(&mut self) {
        self.runtime.close();
    }
}
