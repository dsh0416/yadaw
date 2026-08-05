use std::{
    mem, ptr,
    sync::{Arc, RwLock, mpsc},
    time::Duration,
};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    DEVICE_STATE_ACTIVE, IActivateAudioInterfaceAsyncOperation, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, WAVEFORMATEX, eRender,
};
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{
    BLOB, CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
};
use windows::Win32::System::Threading::{
    CreateEventA, OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW, WaitForSingleObject,
};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{IUnknown, Interface, PCSTR, PCWSTR, PWSTR, implement};

use super::{
    ApplicationCaptureBackend, ApplicationCaptureCounters, ApplicationCaptureFrame,
    ApplicationCaptureLogicalTarget, ApplicationCaptureSnapshot,
    ApplicationCaptureTargetDescriptor, PreparedApplicationCapture,
};

const PROCESS_LOOPBACK_DEVICE_INTERFACE: PCWSTR = windows::core::w!("VAD\\Process_Loopback");
const APPLICATION_CAPTURE_STATUS_CAPTURING: u32 = 1;
const APPLICATION_CAPTURE_STATUS_NO_STREAM: u32 = 2;
const APPLICATION_CAPTURE_STATUS_TARGET_MISSING: u32 = 3;
const APPLICATION_CAPTURE_STATUS_AMBIGUOUS_TARGET: u32 = 4;
const APPLICATION_CAPTURE_STATUS_TARGET_EXITED: u32 = 5;
const APPLICATION_CAPTURE_STATUS_UNSUPPORTED: u32 = 6;
const APPLICATION_CAPTURE_STATUS_ERROR: u32 = 7;

pub(super) struct WindowsApplicationCaptureBackend {
    snapshots: Arc<RwLock<Vec<ApplicationCaptureSnapshot>>>,
}

impl WindowsApplicationCaptureBackend {
    pub(super) fn new() -> Self {
        Self {
            snapshots: Arc::new(RwLock::new(Vec::new())),
        }
    }
}

impl ApplicationCaptureBackend for WindowsApplicationCaptureBackend {
    fn enumerate_targets(&self) -> Vec<ApplicationCaptureTargetDescriptor> {
        // Some callers already run inside a non-MTA COM apartment. Keep the
        // WASAPI session walk on a fresh MTA thread so CoInitializeEx cannot
        // fail with RPC_E_CHANGED_MODE and silently produce an empty list.
        std::thread::Builder::new()
            .name("wasapi-application-session-enumerator".to_owned())
            .spawn(enumerate_wasapi_sessions)
            .ok()
            .and_then(|worker| worker.join().ok())
            .unwrap_or_default()
    }

    fn snapshot(&self) -> Vec<ApplicationCaptureSnapshot> {
        self.snapshots
            .read()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    fn prepare_capture(
        &self,
        target: &ApplicationCaptureLogicalTarget,
        session_sample_rate: u32,
    ) -> Result<PreparedApplicationCapture, String> {
        let descriptor = self
            .enumerate_targets()
            .into_iter()
            .find(|candidate| {
                candidate
                    .logical_target
                    .executable_path
                    .eq_ignore_ascii_case(&target.executable_path)
            })
            .ok_or_else(|| "application capture target is not running".to_owned())?;
        let (prepared, producer) =
            PreparedApplicationCapture::new(session_sample_rate, descriptor.channel_count);
        let active = prepared.active.clone();
        let stop = prepared.stop.clone();
        let counters = prepared.counters.clone();
        let status = prepared.status.clone();
        let pid = descriptor.process_id;
        let runtime_id = descriptor.runtime_id.clone();
        let capture_sample_rate = session_sample_rate;
        let include_process_tree = target.include_process_tree;
        if let Ok(mut snapshots) = self.snapshots.write() {
            snapshots.retain(|snapshot| snapshot.runtime_id != descriptor.runtime_id);
            snapshots.push(ApplicationCaptureSnapshot {
                runtime_id: descriptor.runtime_id.clone(),
                process_id: Some(descriptor.process_id),
                display_name: descriptor.display_name.clone(),
                executable_path: descriptor.executable_path.clone(),
                logical_target: descriptor.logical_target.clone(),
                channel_count: descriptor.channel_count,
                status: "capturing".to_owned(),
                dropout_frames: 0,
                overflow_frames: 0,
                underflow_frames: 0,
            });
        }
        let snapshots = Arc::clone(&self.snapshots);
        std::thread::Builder::new()
            .name(format!("wasapi-process-loopback-{pid}"))
            .spawn(move || {
                capture_thread(
                    pid,
                    include_process_tree,
                    active,
                    stop,
                    counters,
                    status,
                    producer,
                    capture_sample_rate,
                    snapshots,
                    runtime_id,
                );
            })
            .map_err(|error| format!("could not start process loopback capture: {error}"))?;
        Ok(prepared)
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_thread(
    process_id: u32,
    include_process_tree: bool,
    active: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    counters: std::sync::Arc<ApplicationCaptureCounters>,
    status: std::sync::Arc<std::sync::atomic::AtomicU32>,
    producer: ringbuf::HeapProd<ApplicationCaptureFrame>,
    capture_sample_rate: u32,
    snapshots: Arc<RwLock<Vec<ApplicationCaptureSnapshot>>>,
    runtime_id: String,
) {
    while !active.load(std::sync::atomic::Ordering::Acquire)
        && !stop.load(std::sync::atomic::Ordering::Acquire)
    {
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    if stop.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    // SAFETY: this worker owns the COM apartment and all WASAPI interfaces it creates.
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            status.store(
                APPLICATION_CAPTURE_STATUS_ERROR,
                std::sync::atomic::Ordering::Release,
            );
            return;
        }
        let result = run_process_loopback(
            process_id,
            include_process_tree,
            &stop,
            &status,
            &counters,
            producer,
            capture_sample_rate,
        );
        windows::Win32::System::Com::CoUninitialize();
        if result.is_err()
            && !stop.load(std::sync::atomic::Ordering::Acquire)
            && status.load(std::sync::atomic::Ordering::Acquire)
                != APPLICATION_CAPTURE_STATUS_UNSUPPORTED
        {
            status.store(
                APPLICATION_CAPTURE_STATUS_ERROR,
                std::sync::atomic::Ordering::Release,
            );
        }
        update_snapshot(
            &snapshots,
            &runtime_id,
            status.load(std::sync::atomic::Ordering::Acquire),
            &counters,
        );
    }
}

fn update_snapshot(
    snapshots: &Arc<RwLock<Vec<ApplicationCaptureSnapshot>>>,
    runtime_id: &str,
    status: u32,
    counters: &ApplicationCaptureCounters,
) {
    let Ok(mut snapshots) = snapshots.write() else {
        return;
    };
    let Some(snapshot) = snapshots
        .iter_mut()
        .find(|snapshot| snapshot.runtime_id == runtime_id)
    else {
        return;
    };
    snapshot.status = status_name(status).to_owned();
    snapshot.dropout_frames = counters
        .dropout_frames
        .load(std::sync::atomic::Ordering::Relaxed);
    snapshot.overflow_frames = counters
        .overflow_frames
        .load(std::sync::atomic::Ordering::Relaxed);
    snapshot.underflow_frames = counters
        .underflow_frames
        .load(std::sync::atomic::Ordering::Relaxed);
}

fn status_name(status: u32) -> &'static str {
    match status {
        super::APPLICATION_CAPTURE_STATUS_INACTIVE => "inactive",
        APPLICATION_CAPTURE_STATUS_CAPTURING => "capturing",
        APPLICATION_CAPTURE_STATUS_NO_STREAM => "no-stream",
        APPLICATION_CAPTURE_STATUS_TARGET_MISSING => "target-missing",
        APPLICATION_CAPTURE_STATUS_AMBIGUOUS_TARGET => "ambiguous-target",
        APPLICATION_CAPTURE_STATUS_TARGET_EXITED => "target-exited",
        APPLICATION_CAPTURE_STATUS_UNSUPPORTED => "unsupported",
        _ => "error",
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn run_process_loopback(
    process_id: u32,
    include_process_tree: bool,
    stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    status: &std::sync::Arc<std::sync::atomic::AtomicU32>,
    counters: &std::sync::Arc<ApplicationCaptureCounters>,
    mut producer: ringbuf::HeapProd<ApplicationCaptureFrame>,
    capture_sample_rate: u32,
) -> Result<(), String> {
    let audio_client =
        activate_process_loopback(process_id, include_process_tree).map_err(|error| {
            if error.code() == windows::Win32::Foundation::E_NOINTERFACE
                || error.code() == windows::Win32::Foundation::E_NOTIMPL
            {
                status.store(
                    APPLICATION_CAPTURE_STATUS_UNSUPPORTED,
                    std::sync::atomic::Ordering::Release,
                );
            }
            format!("process loopback activation failed: {error}")
        })?;

    let (wave_format, format) = requested_capture_format(capture_sample_rate);
    let initialize_result = audio_client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | AUDCLNT_STREAMFLAGS_LOOPBACK,
        0,
        0,
        &wave_format,
        None,
    );
    initialize_result.map_err(|error| format!("WASAPI client initialization failed: {error}"))?;

    let event = CreateEventA(None, false, false, PCSTR::null())
        .map_err(|error| format!("WASAPI event creation failed: {error}"))?;
    let result = (|| {
        audio_client
            .SetEventHandle(event)
            .map_err(|error| format!("WASAPI event setup failed: {error}"))?;
        let capture_client = audio_client
            .GetService::<IAudioCaptureClient>()
            .map_err(|error| format!("WASAPI capture client failed: {error}"))?;
        audio_client
            .Start()
            .map_err(|error| format!("WASAPI capture start failed: {error}"))?;
        status.store(
            APPLICATION_CAPTURE_STATUS_CAPTURING,
            std::sync::atomic::Ordering::Release,
        );
        capture_packets(
            &capture_client,
            event,
            &format,
            stop,
            counters,
            &mut producer,
        )
    })();
    let _ = audio_client.Stop();
    CloseHandle(event).ok();
    result
}

fn requested_capture_format(sample_rate: u32) -> (WAVEFORMATEX, MixFormat) {
    let wave_format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
        nChannels: 2,
        nSamplesPerSec: sample_rate,
        nAvgBytesPerSec: sample_rate.saturating_mul(8),
        nBlockAlign: 8,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    let format = MixFormat {
        channels: 2,
        sample_rate,
        block_align: 8,
        bits_per_sample: 32,
        float32: true,
    };
    (wave_format, format)
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn activate_process_loopback(
    process_id: u32,
    include_process_tree: bool,
) -> windows::core::Result<IAudioClient> {
    #[implement(windows::Win32::Media::Audio::IActivateAudioInterfaceCompletionHandler)]
    struct CompletionHandler(mpsc::Sender<windows::core::Result<IUnknown>>);

    fn retrieve_activation_result(
        operation: &IActivateAudioInterfaceAsyncOperation,
    ) -> windows::core::Result<IUnknown> {
        let mut result = windows::core::HRESULT::default();
        let mut interface: Option<IUnknown> = None;
        // SAFETY: the completion callback is invoked with a valid COM operation reference.
        unsafe {
            operation.GetActivateResult(&mut result, &mut interface)?;
        }
        result.ok()?;
        interface.ok_or_else(|| {
            windows::core::Error::new(
                windows::Win32::Media::Audio::AUDCLNT_E_DEVICE_INVALIDATED,
                "audio interface was not returned after activation",
            )
        })
    }

    impl windows::Win32::Media::Audio::IActivateAudioInterfaceCompletionHandler_Impl
        for CompletionHandler_Impl
    {
        fn ActivateCompleted(
            &self,
            operation: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            let result = operation.ok().and_then(retrieve_activation_result);
            let _ = self.0.send(result);
            Ok(())
        }
    }

    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams:
                windows::Win32::Media::Audio::AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: process_id,
                    ProcessLoopbackMode: if include_process_tree {
                        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                    } else {
                        // Windows has no include-target-only mode. Preserve
                        // target capture by including its process tree.
                        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                    },
                },
        },
    };
    let activation_params = std::mem::ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: (&params as *const AUDIOCLIENT_ACTIVATION_PARAMS)
                            .cast_mut()
                            .cast(),
                    },
                },
            }),
        },
    });
    let (sender, receiver) = mpsc::channel();
    let handler: windows::Win32::Media::Audio::IActivateAudioInterfaceCompletionHandler =
        CompletionHandler(sender).into();
    windows::Win32::Media::Audio::ActivateAudioInterfaceAsync(
        PROCESS_LOOPBACK_DEVICE_INTERFACE,
        &IAudioClient::IID,
        Some((&*activation_params) as *const _),
        &handler,
    )?;
    let interface = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| {
            windows::core::Error::new(
                windows::Win32::Foundation::ERROR_TIMEOUT.to_hresult(),
                "timed out waiting for process loopback activation",
            )
        })??;
    interface.cast()
}

#[derive(Clone, Copy)]
struct MixFormat {
    channels: usize,
    sample_rate: u32,
    block_align: usize,
    bits_per_sample: usize,
    float32: bool,
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn capture_packets(
    capture_client: &IAudioCaptureClient,
    event: HANDLE,
    format: &MixFormat,
    stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    counters: &std::sync::Arc<ApplicationCaptureCounters>,
    producer: &mut ringbuf::HeapProd<ApplicationCaptureFrame>,
) -> Result<(), String> {
    use ringbuf::traits::Producer;

    debug_assert!(format.sample_rate > 0);
    while !stop.load(std::sync::atomic::Ordering::Acquire) {
        let wait_result = WaitForSingleObject(event, 50);
        if wait_result != windows::Win32::Foundation::WAIT_OBJECT_0
            && wait_result != windows::Win32::Foundation::WAIT_TIMEOUT
        {
            return Err("WASAPI event wait failed".to_owned());
        }
        loop {
            let packet_frames = capture_client
                .GetNextPacketSize()
                .map_err(|error| format!("WASAPI packet query failed: {error}"))?;
            if packet_frames == 0 {
                break;
            }
            let mut data = ptr::null_mut();
            let mut frames = packet_frames;
            let mut flags = 0u32;
            let mut device_position = 0u64;
            let mut qpc_position = 0u64;
            capture_client
                .GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc_position),
                )
                .map_err(|error| format!("WASAPI packet read failed: {error}"))?;

            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
            let bytes = if silent || data.is_null() {
                None
            } else {
                Some(std::slice::from_raw_parts(
                    data,
                    frames as usize * format.block_align,
                ))
            };
            for frame_index in 0..frames as usize {
                let frame = if let Some(bytes) = bytes {
                    decode_frame(&bytes[frame_index * format.block_align..], format)
                } else {
                    [0.0, 0.0]
                };
                if producer.try_push(frame).is_err() {
                    counters
                        .overflow_frames
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    counters
                        .dropout_frames
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
            capture_client
                .ReleaseBuffer(frames)
                .map_err(|error| format!("WASAPI packet release failed: {error}"))?;
        }
    }
    Ok(())
}

fn decode_frame(bytes: &[u8], format: &MixFormat) -> ApplicationCaptureFrame {
    let left = decode_sample(&bytes[..format.bytes_per_sample()], format);
    let right = if format.channels > 1 {
        decode_sample(&bytes[format.bytes_per_sample()..], format)
    } else {
        0.0
    };
    [left, right]
}

impl MixFormat {
    fn bytes_per_sample(&self) -> usize {
        (self.bits_per_sample / 8).max(1)
    }
}

fn decode_sample(bytes: &[u8], format: &MixFormat) -> f32 {
    if format.float32 && bytes.len() >= 4 {
        return f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    }
    match format.bits_per_sample {
        8 => (bytes.first().copied().unwrap_or(128) as f32 - 128.0) / 128.0,
        16 if bytes.len() >= 2 => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32,
        24 if bytes.len() >= 3 => {
            let value = (bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16);
            let signed = if value & 0x80_0000 != 0 {
                value | !0xFF_FFFF
            } else {
                value
            };
            signed as f32 / 8_388_607.0
        }
        32 if bytes.len() >= 4 => {
            i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / i32::MAX as f32
        }
        _ => 0.0,
    }
}

fn enumerate_wasapi_sessions() -> Vec<ApplicationCaptureTargetDescriptor> {
    // SAFETY: COM is initialized for this function's thread and all COM
    // interfaces are used only on that thread.  The Windows crate wrappers
    // retain the COM reference counts for us.
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return Vec::new();
        }
        let result = enumerate_wasapi_sessions_inner();
        windows::Win32::System::Com::CoUninitialize();
        result
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn enumerate_wasapi_sessions_inner() -> Vec<ApplicationCaptureTargetDescriptor> {
    let enumerator: IMMDeviceEnumerator =
        match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };
    let endpoints = match enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut targets = Vec::new();
    let count = endpoints.GetCount().unwrap_or(0);
    for index in 0..count {
        let Ok(endpoint) = endpoints.Item(index) else {
            continue;
        };
        let Ok(manager) = endpoint.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
            continue;
        };
        let Ok(sessions) = manager.GetSessionEnumerator() else {
            continue;
        };
        let session_count = sessions.GetCount().unwrap_or(0);
        for session_index in 0..session_count {
            let Ok(control) = sessions.GetSession(session_index) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(process_id) = control2.GetProcessId() else {
                continue;
            };
            if process_id == 0 || !seen.insert(process_id) {
                continue;
            }
            let Some(path) = process_path(process_id) else {
                continue;
            };
            let executable_name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
            let display_name = control
                .GetDisplayName()
                .ok()
                .and_then(|value| value.to_string().ok())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| executable_name.clone());
            let logical_target = ApplicationCaptureLogicalTarget {
                platform: "windows".to_string(),
                executable_path: path.clone(),
                executable_name: executable_name.clone(),
                include_process_tree: true,
            };
            targets.push(ApplicationCaptureTargetDescriptor {
                runtime_id: format!("windows-process-{process_id}"),
                process_id,
                display_name,
                executable_path: path,
                logical_target,
                channel_count: 2,
                status: "inactive".to_string(),
            });
        }
    }
    targets.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    targets
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn process_path(process_id: u32) -> Option<String> {
    // SAFETY: the handle is only used for querying the image name and is closed below.
    let process: HANDLE =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()? };
    let mut buffer = [0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` is writable and `length` is initialized to its capacity.
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .ok()
        .map(|()| String::from_utf16_lossy(&buffer[..length as usize]))
    };
    // SAFETY: `process` was returned by OpenProcess and has not been closed yet.
    let _ = unsafe { CloseHandle(process) };
    result
}

#[cfg(test)]
mod tests {
    use super::{PROCESS_LOOPBACK_DEVICE_INTERFACE, requested_capture_format};

    #[test]
    fn process_loopback_uses_the_virtual_device_and_session_float_format() {
        let (wave, decoded) = requested_capture_format(48_000);
        let channels = wave.nChannels;
        let sample_rate = wave.nSamplesPerSec;
        let bits_per_sample = wave.wBitsPerSample;
        let block_align = wave.nBlockAlign;
        assert_eq!(
            // SAFETY: this points to the static, NUL-terminated UTF-16 literal above.
            unsafe { PROCESS_LOOPBACK_DEVICE_INTERFACE.to_string().unwrap() },
            "VAD\\Process_Loopback"
        );
        assert_eq!(channels, 2);
        assert_eq!(sample_rate, 48_000);
        assert_eq!(bits_per_sample, 32);
        assert_eq!(block_align, 8);
        assert_eq!(decoded.sample_rate, 48_000);
        assert!(decoded.float32);
    }
}
