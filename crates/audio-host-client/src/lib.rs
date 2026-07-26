use std::{
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use ipc_channel::ipc::{self, IpcOneShotServer, IpcReceiver, IpcSender};
use napi::{
    Error, Result, Status, Task,
    bindgen_prelude::{AsyncTask, Buffer},
};
use napi_derive::napi;
use yadaw_dsp_runtime::protocol::{
    ControlRequest, ControlResponse, ControlResult, HostBootstrap, MAX_MESSAGE_BYTES,
    PROTOCOL_VERSION,
};

fn failure(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

struct ClientState {
    transport: Mutex<Transport>,
    events: Mutex<IpcReceiver<Vec<u8>>>,
    child: Mutex<Child>,
    closing: AtomicBool,
}

struct Transport {
    requests: IpcSender<Vec<u8>>,
    responses: IpcReceiver<Vec<u8>>,
}

#[napi]
pub struct AudioHostIpcClient {
    state: Arc<ClientState>,
}

#[napi]
impl AudioHostIpcClient {
    #[napi(constructor)]
    pub fn new(
        executable_path: String,
        bridge_path: String,
        crash_marker_path: String,
    ) -> Result<Self> {
        let (server, token) = IpcOneShotServer::<IpcSender<HostBootstrap>>::new()
            .map_err(|error| failure("could not create helper IPC server", error))?;
        let mut child = Command::new(&executable_path)
            .arg("--ipc-token")
            .arg(token)
            .arg("--vst3-bridge")
            .arg(bridge_path)
            .arg("--crash-marker")
            .arg(crash_marker_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| failure("could not start audio host", error))?;
        let (requests, request_receiver) =
            ipc::channel().map_err(|error| failure("could not create request channel", error))?;
        let (response_sender, responses) =
            ipc::channel().map_err(|error| failure("could not create response channel", error))?;
        let (event_sender, events) =
            ipc::channel().map_err(|error| failure("could not create event channel", error))?;
        let (_, bootstrap_sender) = server.accept().map_err(|error| {
            let _ = child.kill();
            failure("audio host did not connect to IPC", error)
        })?;
        bootstrap_sender
            .send(HostBootstrap {
                requests: request_receiver,
                responses: response_sender,
                events: event_sender,
            })
            .map_err(|error| {
                let _ = child.kill();
                failure("could not transfer helper channels", error)
            })?;

        Ok(Self {
            state: Arc::new(ClientState {
                transport: Mutex::new(Transport {
                    requests,
                    responses,
                }),
                events: Mutex::new(events),
                child: Mutex::new(child),
                closing: AtomicBool::new(false),
            }),
        })
    }

    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn request(&self, message_pack_request: Buffer) -> Result<AsyncTask<RequestTask>> {
        if self.state.closing.load(Ordering::Acquire) {
            return Err(failure("audio-host request", "client is closing"));
        }
        if message_pack_request.len() > MAX_MESSAGE_BYTES {
            return Err(Error::new(
                Status::InvalidArg,
                "audio-host request exceeds 64 MiB",
            ));
        }
        let request = rmp_serde::from_slice::<ControlRequest>(&message_pack_request)
            .map_err(|error| failure("invalid audio-host request", error))?;
        Ok(AsyncTask::new(RequestTask {
            state: Arc::clone(&self.state),
            request_id: request.request_id,
            request: Some(message_pack_request.to_vec()),
        }))
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        self.state.closing.store(true, Ordering::Release);
        let mut child = self
            .state
            .child
            .lock()
            .map_err(|_| failure("audio host process lock", "poisoned"))?;
        match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                child
                    .kill()
                    .map_err(|error| failure("could not stop audio host", error))?;
                child
                    .wait()
                    .map_err(|error| failure("could not reap audio host", error))?;
                Ok(())
            }
            Err(error) => Err(failure("could not inspect audio host", error)),
        }
    }
}

pub struct RequestTask {
    state: Arc<ClientState>,
    request_id: u64,
    request: Option<Vec<u8>>,
}

impl Task for RequestTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        // Operational IPC failures are returned as a normal wire response. This keeps napi-rs
        // from trying to reject a Promise after Electron has already begun tearing down the
        // Node environment.
        Ok(self.compute_request().unwrap_or_else(|message| {
            rmp_serde::to_vec_named(&ControlResponse {
                version: PROTOCOL_VERSION,
                request_id: self.request_id,
                result: ControlResult::Error { message },
            })
            .unwrap_or_default()
        }))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

impl RequestTask {
    fn compute_request(&mut self) -> std::result::Result<Vec<u8>, String> {
        let request = self
            .request
            .take()
            .ok_or_else(|| "audio-host request task was already consumed".to_string())?;
        if self.state.closing.load(Ordering::Acquire) {
            return Err("audio-host client is closing".to_string());
        }
        let transport = self
            .state
            .transport
            .lock()
            .map_err(|_| "audio-host transport lock was poisoned".to_string())?;
        if self.state.closing.load(Ordering::Acquire) {
            return Err("audio-host client is closing".to_string());
        }
        transport
            .requests
            .send(request)
            .map_err(|error| format!("could not send audio-host request: {error}"))?;
        let response_bytes = transport
            .responses
            .try_recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("audio-host response failed: {error}"))?;
        if response_bytes.len() > MAX_MESSAGE_BYTES {
            return Err("audio-host response exceeds 64 MiB".to_string());
        }
        let response = rmp_serde::from_slice::<ControlResponse>(&response_bytes)
            .map_err(|error| format!("invalid audio-host response: {error}"))?;
        if response.request_id != self.request_id {
            return Err("audio-host response request identifier did not match".to_string());
        }
        Ok(response_bytes)
    }
}

impl Drop for ClientState {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(events) = self.events.get_mut() {
            while events.try_recv().is_ok() {}
        }
    }
}
