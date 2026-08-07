use std::{
    collections::BTreeMap,
    ffi::c_void,
    mem::{self, MaybeUninit},
    ptr::{self, NonNull},
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use objc2::AnyThread;
use objc2_app_kit::NSRunningApplication;
use objc2_core_audio::{
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart,
    AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
    AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior, kAudioDevicePermissionsError,
    kAudioDevicePropertyBufferFrameSize, kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioProcessPropertyIsRunningOutput, kAudioProcessPropertyPID, kAudioTapPropertyFormat,
};
use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatLinearPCM,
};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFString, CFType};
use objc2_foundation::{NSArray, NSNumber};
use ringbuf::{HeapProd, traits::Producer};

use super::{
    APPLICATION_CAPTURE_STATUS_CAPTURING, APPLICATION_CAPTURE_STATUS_ERROR,
    APPLICATION_CAPTURE_STATUS_NO_STREAM, APPLICATION_CAPTURE_STATUS_PERMISSION_DENIED,
    APPLICATION_CAPTURE_STATUS_TARGET_EXITED, APPLICATION_CAPTURE_STATUS_TARGET_MISSING,
    ApplicationCaptureBackend, ApplicationCaptureError, ApplicationCaptureFrame,
    ApplicationCaptureLogicalTarget, ApplicationCaptureRegistry, ApplicationCaptureSnapshot,
    ApplicationCaptureState, ApplicationCaptureTargetDescriptor, PreparedApplicationCapture,
};

const NO_ERR: i32 = 0;
const NO_STREAM_POLL_LIMIT: u8 = 2;

pub(super) struct MacOsApplicationCaptureBackend {
    registry: Arc<ApplicationCaptureRegistry>,
}

impl MacOsApplicationCaptureBackend {
    pub(super) fn new() -> Self {
        Self {
            registry: Arc::new(ApplicationCaptureRegistry::default()),
        }
    }
}

impl ApplicationCaptureBackend for MacOsApplicationCaptureBackend {
    fn enumerate_targets(&self) -> Vec<ApplicationCaptureTargetDescriptor> {
        enumerate_mac_targets()
            .into_iter()
            .map(|target| target.descriptor)
            .collect()
    }

    fn snapshot(&self) -> Vec<ApplicationCaptureSnapshot> {
        self.registry.snapshot()
    }

    fn prepare_capture(
        &self,
        target: &ApplicationCaptureLogicalTarget,
        session_sample_rate: u32,
    ) -> Result<PreparedApplicationCapture, ApplicationCaptureError> {
        if target.platform != "macos" {
            return Err(ApplicationCaptureError::InvalidConfiguration(
                "macOS application capture requires a macos target".to_owned(),
            ));
        }

        let selected = enumerate_mac_targets()
            .into_iter()
            .find(|candidate| logical_target_matches(target, &candidate.descriptor.logical_target));
        let Some(selected) = selected else {
            let descriptor = ApplicationCaptureTargetDescriptor {
                runtime_id: format!("macos-missing:{}", logical_target_key(target)),
                process_id: 0,
                display_name: target.executable_name.clone(),
                executable_path: target.executable_path.clone(),
                logical_target: target.clone(),
                channel_count: 2,
                status: "target-missing".to_owned(),
            };
            let prepared = PreparedApplicationCapture::silent(
                descriptor,
                session_sample_rate,
                APPLICATION_CAPTURE_STATUS_TARGET_MISSING,
            )?;
            self.registry.register(&prepared.state);
            return Ok(prepared);
        };

        let (resources, format, block_frames) =
            MacCaptureResources::prepare(&selected.process_object_ids)?;
        let source_sample_rate = format.sample_rate.round();
        if !source_sample_rate.is_finite()
            || source_sample_rate < 1.0
            || source_sample_rate > f64::from(u32::MAX)
        {
            return Err(ApplicationCaptureError::Platform(
                "Core Audio tap returned an invalid sample rate".to_owned(),
            ));
        }
        let source_sample_rate = source_sample_rate as u32;
        let (prepared, producer) = PreparedApplicationCapture::new(
            selected.descriptor.clone(),
            source_sample_rate,
            session_sample_rate,
            format.channels,
            block_frames,
        )?;
        self.registry.register(&prepared.state);
        let state = Arc::clone(&prepared.state);
        let root_process_id = selected.descriptor.process_id;
        std::thread::Builder::new()
            .name(format!("coreaudio-process-tap-{root_process_id}"))
            .spawn(move || {
                run_capture_worker(resources, format, root_process_id, state, producer);
            })
            .map_err(ApplicationCaptureError::WorkerStart)?;
        Ok(prepared)
    }
}

#[derive(Clone)]
struct MacTarget {
    descriptor: ApplicationCaptureTargetDescriptor,
    process_object_ids: Vec<AudioObjectID>,
}

#[derive(Clone)]
struct ApplicationMetadata {
    process_id: u32,
    bundle_identifier: Option<String>,
    executable_path: String,
    display_name: String,
}

fn enumerate_mac_targets() -> Vec<MacTarget> {
    let Ok(process_objects) = property_vec_u32(
        u32::try_from(kAudioObjectSystemObject).unwrap_or(1),
        kAudioHardwarePropertyProcessObjectList,
    ) else {
        return Vec::new();
    };
    let own_process_id = std::process::id();
    let mut grouped = BTreeMap::<String, MacTarget>::new();
    for process_object_id in process_objects {
        if property_value::<u32>(process_object_id, kAudioProcessPropertyIsRunningOutput)
            .unwrap_or(0)
            == 0
        {
            continue;
        }
        let Ok(pid) = property_value::<libc::pid_t>(process_object_id, kAudioProcessPropertyPID)
        else {
            continue;
        };
        let Ok(pid) = u32::try_from(pid) else {
            continue;
        };
        let Some(metadata) = root_application_metadata(pid) else {
            continue;
        };
        if metadata.process_id == own_process_id {
            continue;
        }
        let executable_name = metadata
            .executable_path
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(&metadata.display_name)
            .to_owned();
        let logical_target = ApplicationCaptureLogicalTarget {
            platform: "macos".to_owned(),
            bundle_identifier: metadata.bundle_identifier.clone(),
            executable_path: metadata.executable_path.clone(),
            executable_name,
            include_process_tree: true,
        };
        let key = logical_target_key(&logical_target);
        grouped
            .entry(key)
            .and_modify(|target| {
                if !target.process_object_ids.contains(&process_object_id) {
                    target.process_object_ids.push(process_object_id);
                }
            })
            .or_insert_with(|| MacTarget {
                descriptor: ApplicationCaptureTargetDescriptor {
                    runtime_id: format!("macos-process-{}", metadata.process_id),
                    process_id: metadata.process_id,
                    display_name: metadata.display_name,
                    executable_path: metadata.executable_path,
                    logical_target,
                    channel_count: 2,
                    status: "inactive".to_owned(),
                },
                process_object_ids: vec![process_object_id],
            });
    }
    let mut targets = grouped.into_values().collect::<Vec<_>>();
    targets.sort_by(|left, right| {
        left.descriptor
            .display_name
            .to_lowercase()
            .cmp(&right.descriptor.display_name.to_lowercase())
    });
    targets
}

fn logical_target_key(target: &ApplicationCaptureLogicalTarget) -> String {
    target
        .bundle_identifier
        .as_deref()
        .filter(|value| !value.is_empty())
        .map_or_else(
            || target.executable_path.to_lowercase(),
            |value| value.to_lowercase(),
        )
}

fn logical_target_matches(
    requested: &ApplicationCaptureLogicalTarget,
    candidate: &ApplicationCaptureLogicalTarget,
) -> bool {
    match (
        requested.bundle_identifier.as_deref(),
        candidate.bundle_identifier.as_deref(),
    ) {
        (Some(requested), Some(candidate)) if !requested.is_empty() => {
            requested.eq_ignore_ascii_case(candidate)
        }
        _ => requested.executable_path == candidate.executable_path,
    }
}

fn root_application_metadata(process_id: u32) -> Option<ApplicationMetadata> {
    let mut current = process_id;
    let mut fallback = None;
    for _ in 0..32 {
        if let Some(metadata) = running_application_metadata(current) {
            if fallback.is_none() {
                fallback = Some(metadata.clone());
            }
            if is_root_application_executable(&metadata.executable_path) {
                fallback = Some(metadata);
            }
        }
        let Some(parent) = parent_process_id(current) else {
            break;
        };
        if parent <= 1 || parent == current {
            break;
        }
        current = parent;
    }
    fallback.or_else(|| {
        process_path(process_id).map(|executable_path| ApplicationMetadata {
            process_id,
            bundle_identifier: None,
            display_name: executable_path
                .rsplit('/')
                .next()
                .unwrap_or("Application")
                .to_owned(),
            executable_path,
        })
    })
}

fn running_application_metadata(process_id: u32) -> Option<ApplicationMetadata> {
    let pid = libc::pid_t::try_from(process_id).ok()?;
    let application = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
    let executable_path = application.executableURL()?.path()?.to_string();
    let display_name = application
        .localizedName()
        .map(|name| name.to_string())
        .filter(|name| !name.trim().is_empty())
        .or_else(|| executable_path.rsplit('/').next().map(ToOwned::to_owned))?;
    Some(ApplicationMetadata {
        process_id,
        bundle_identifier: application
            .bundleIdentifier()
            .map(|value| value.to_string()),
        executable_path,
        display_name,
    })
}

fn is_root_application_executable(path: &str) -> bool {
    path.contains(".app/Contents/MacOS/") && !path.contains(".app/Contents/Frameworks/")
}

fn parent_process_id(process_id: u32) -> Option<u32> {
    let pid = libc::pid_t::try_from(process_id).ok()?;
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let expected = i32::try_from(mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: `info` points to writable storage of the exact size passed to libproc.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected,
        )
    };
    if written != expected {
        return None;
    }
    // SAFETY: libproc reported that it initialized the complete structure.
    Some(unsafe { info.assume_init() }.pbi_ppid)
}

fn process_path(process_id: u32) -> Option<String> {
    let pid = libc::pid_t::try_from(process_id).ok()?;
    let capacity = usize::try_from(libc::PROC_PIDPATHINFO_MAXSIZE).ok()?;
    let mut buffer = vec![0_u8; capacity];
    // SAFETY: `buffer` is writable for the exact capacity passed to libproc.
    let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), capacity as u32) };
    if length <= 0 {
        return None;
    }
    let length = usize::try_from(length).ok()?.min(buffer.len());
    let bytes = &buffer[..length];
    Some(
        String::from_utf8_lossy(bytes)
            .trim_end_matches('\0')
            .to_string(),
    )
}

fn property_address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

fn property_vec_u32(object_id: AudioObjectID, selector: u32) -> Result<Vec<u32>, i32> {
    let mut address = property_address(selector);
    let mut size = 0_u32;
    // SAFETY: both non-null pointers reference initialized writable values for the duration.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            object_id,
            NonNull::from(&mut address),
            0,
            ptr::null(),
            NonNull::from(&mut size),
        )
    };
    if status != NO_ERR {
        return Err(status);
    }
    let count = usize::try_from(size).unwrap_or(0) / mem::size_of::<u32>();
    let mut values = vec![0_u32; count];
    if values.is_empty() {
        return Ok(values);
    }
    let Some(output) = NonNull::new(values.as_mut_ptr().cast::<c_void>()) else {
        return Ok(Vec::new());
    };
    // SAFETY: `output` points to `size` writable bytes and the address requests u32 object IDs.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object_id,
            NonNull::from(&mut address),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            output,
        )
    };
    if status != NO_ERR {
        return Err(status);
    }
    values.truncate(usize::try_from(size).unwrap_or(0) / mem::size_of::<u32>());
    Ok(values)
}

fn property_value<T: Copy>(object_id: AudioObjectID, selector: u32) -> Result<T, i32> {
    let mut address = property_address(selector);
    let mut value = MaybeUninit::<T>::uninit();
    let mut size = u32::try_from(mem::size_of::<T>()).unwrap_or(u32::MAX);
    let output = NonNull::new(value.as_mut_ptr().cast::<c_void>()).ok_or(-1)?;
    // SAFETY: `output` points to writable storage of `size` bytes for the requested property.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object_id,
            NonNull::from(&mut address),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            output,
        )
    };
    if status != NO_ERR || usize::try_from(size).unwrap_or(0) != mem::size_of::<T>() {
        return Err(status);
    }
    // SAFETY: Core Audio returned success and the full value size.
    Ok(unsafe { value.assume_init() })
}

#[derive(Clone, Copy)]
struct TapFormat {
    sample_rate: f64,
    channels: u32,
    non_interleaved: bool,
    bytes_per_frame: usize,
}

impl TapFormat {
    fn from_asbd(value: AudioStreamBasicDescription) -> Result<Self, ApplicationCaptureError> {
        if value.mFormatID != kAudioFormatLinearPCM
            || value.mFormatFlags & kAudioFormatFlagIsFloat == 0
            || value.mBitsPerChannel != 32
            || value.mChannelsPerFrame == 0
        {
            return Err(ApplicationCaptureError::Platform(
                "Core Audio process tap did not expose Float32 linear PCM".to_owned(),
            ));
        }
        Ok(Self {
            sample_rate: value.mSampleRate,
            channels: value.mChannelsPerFrame,
            non_interleaved: value.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0,
            bytes_per_frame: usize::try_from(value.mBytesPerFrame).unwrap_or(0).max(4),
        })
    }
}

struct MacCaptureResources {
    tap_id: AudioObjectID,
    aggregate_device_id: AudioObjectID,
    process_object_ids: Vec<AudioObjectID>,
}

impl MacCaptureResources {
    fn prepare(
        process_object_ids: &[AudioObjectID],
    ) -> Result<(Self, TapFormat, usize), ApplicationCaptureError> {
        let numbers = process_object_ids
            .iter()
            .copied()
            .map(NSNumber::numberWithUnsignedInt)
            .collect::<Vec<_>>();
        let processes = NSArray::from_retained_slice(&numbers);
        // SAFETY: the array contains NSNumber-wrapped AudioObjectIDs as required by Core Audio.
        let description = unsafe {
            CATapDescription::initStereoMixdownOfProcesses(CATapDescription::alloc(), &processes)
        };
        // SAFETY: setters only update this exclusively owned description before publication.
        unsafe {
            description.setPrivate(true);
            description.setMuteBehavior(CATapMuteBehavior::Unmuted);
        }
        let mut tap_id = 0;
        // SAFETY: the description is valid and `tap_id` is writable for the call duration.
        let status = unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut tap_id) };
        if status != NO_ERR {
            return Err(platform_status("create process tap", status));
        }

        let mut resources = Self {
            tap_id,
            aggregate_device_id: 0,
            process_object_ids: process_object_ids.to_vec(),
        };

        let tap_format =
            property_value::<AudioStreamBasicDescription>(tap_id, kAudioTapPropertyFormat)
                .map_err(|status| platform_status("read process tap format", status))?;
        let format = TapFormat::from_asbd(tap_format)?;
        // SAFETY: UUID access is read-only on the valid tap description.
        let tap_uid = unsafe { description.UUID().UUIDString() }.to_string();
        let aggregate_uid = format!("live.minori.heron.application-capture.{}", tap_id);
        let aggregate_name = format!("Heron Application Capture {tap_id}");
        let aggregate_description =
            aggregate_device_description(&aggregate_name, &aggregate_uid, &tap_uid);
        let mut aggregate_device_id = 0;
        // SAFETY: the dictionary has the documented aggregate-device value types.
        let status = unsafe {
            let typed_description: &CFDictionary<CFType, CFType> = &aggregate_description;
            let description: &CFDictionary = typed_description.as_ref();
            AudioHardwareCreateAggregateDevice(description, NonNull::from(&mut aggregate_device_id))
        };
        if status != NO_ERR {
            return Err(platform_status("create tap aggregate device", status));
        }
        resources.aggregate_device_id = aggregate_device_id;
        let block_frames =
            property_value::<u32>(aggregate_device_id, kAudioDevicePropertyBufferFrameSize)
                .ok()
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(512)
                .max(1);
        Ok((resources, format, block_frames))
    }
}

impl Drop for MacCaptureResources {
    fn drop(&mut self) {
        if self.aggregate_device_id != 0 {
            // SAFETY: this object owns the aggregate device ID until this drop.
            let _ = unsafe { AudioHardwareDestroyAggregateDevice(self.aggregate_device_id) };
            self.aggregate_device_id = 0;
        }
        if self.tap_id != 0 {
            // SAFETY: this object owns the process tap ID until this drop.
            let _ = unsafe { AudioHardwareDestroyProcessTap(self.tap_id) };
            self.tap_id = 0;
        }
    }
}

fn aggregate_device_description(
    name: &str,
    uid: &str,
    tap_uid: &str,
) -> objc2_core_foundation::CFRetained<CFDictionary<CFType, CFType>> {
    let tap_uid_key = CFString::from_str("uid");
    let tap_drift_key = CFString::from_str("drift");
    let tap_uid_value = CFString::from_str(tap_uid);
    let tap = CFDictionary::<CFType, CFType>::from_slices(
        &[tap_uid_key.as_ref(), tap_drift_key.as_ref()],
        &[tap_uid_value.as_ref(), CFBoolean::new(true).as_ref()],
    );
    let taps = CFArray::<CFDictionary<CFType, CFType>>::from_objects(&[tap.as_ref()]);
    let name_key = CFString::from_str("name");
    let uid_key = CFString::from_str("uid");
    let taps_key = CFString::from_str("taps");
    let autostart_key = CFString::from_str("tapautostart");
    let private_key = CFString::from_str("private");
    let name_value = CFString::from_str(name);
    let uid_value = CFString::from_str(uid);
    CFDictionary::<CFType, CFType>::from_slices(
        &[
            name_key.as_ref(),
            uid_key.as_ref(),
            taps_key.as_ref(),
            autostart_key.as_ref(),
            private_key.as_ref(),
        ],
        &[
            name_value.as_ref(),
            uid_value.as_ref(),
            taps.as_ref(),
            CFBoolean::new(false).as_ref(),
            CFBoolean::new(true).as_ref(),
        ],
    )
}

struct IoContext {
    producer: HeapProd<ApplicationCaptureFrame>,
    state: Arc<ApplicationCaptureState>,
    format: TapFormat,
}

fn run_capture_worker(
    resources: MacCaptureResources,
    format: TapFormat,
    root_process_id: u32,
    state: Arc<ApplicationCaptureState>,
    producer: HeapProd<ApplicationCaptureFrame>,
) {
    while !state.active.load(Ordering::Acquire) && !state.stop.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(2));
    }
    if state.stop.load(Ordering::Acquire) {
        return;
    }

    let context = Box::new(IoContext {
        producer,
        state: Arc::clone(&state),
        format,
    });
    let context_ptr = Box::into_raw(context);
    let mut io_proc_id: AudioDeviceIOProcID = None;
    // SAFETY: `context_ptr` stays allocated until IO is stopped and the IOProc is destroyed.
    let create_status = unsafe {
        AudioDeviceCreateIOProcID(
            resources.aggregate_device_id,
            Some(application_capture_io_proc),
            context_ptr.cast(),
            NonNull::from(&mut io_proc_id),
        )
    };
    if create_status != NO_ERR {
        state
            .status
            .store(status_for_os_status(create_status), Ordering::Release);
        // SAFETY: IOProc creation failed, so Core Audio never retained the context pointer.
        drop(unsafe { Box::from_raw(context_ptr) });
        return;
    }
    // SAFETY: the IOProc ID belongs to this aggregate device and the context remains alive.
    let start_status = unsafe { AudioDeviceStart(resources.aggregate_device_id, io_proc_id) };
    if start_status != NO_ERR {
        state
            .status
            .store(status_for_os_status(start_status), Ordering::Release);
        // SAFETY: the IOProc was created above and has not been destroyed yet.
        let _ = unsafe { AudioDeviceDestroyIOProcID(resources.aggregate_device_id, io_proc_id) };
        // SAFETY: Core Audio no longer references the context after IOProc destruction.
        drop(unsafe { Box::from_raw(context_ptr) });
        return;
    }
    state
        .status
        .store(APPLICATION_CAPTURE_STATUS_CAPTURING, Ordering::Release);

    let mut idle_polls = 0_u8;
    while !state.stop.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_secs(1));
        if !process_is_running(root_process_id) {
            state
                .status
                .store(APPLICATION_CAPTURE_STATUS_TARGET_EXITED, Ordering::Release);
            break;
        }
        if !resources
            .process_object_ids
            .iter()
            .copied()
            .any(|object_id| {
                property_value::<u32>(object_id, kAudioProcessPropertyIsRunningOutput).unwrap_or(0)
                    != 0
            })
        {
            idle_polls = idle_polls.saturating_add(1);
            if idle_polls >= NO_STREAM_POLL_LIMIT {
                state
                    .status
                    .store(APPLICATION_CAPTURE_STATUS_NO_STREAM, Ordering::Release);
            }
        } else {
            idle_polls = 0;
            state
                .status
                .store(APPLICATION_CAPTURE_STATUS_CAPTURING, Ordering::Release);
        }
    }

    // SAFETY: start succeeded, so stop balances it before the IOProc is destroyed.
    let _ = unsafe { AudioDeviceStop(resources.aggregate_device_id, io_proc_id) };
    // SAFETY: the IOProc belongs to this aggregate device and is no longer running.
    let _ = unsafe { AudioDeviceDestroyIOProcID(resources.aggregate_device_id, io_proc_id) };
    // SAFETY: Core Audio cannot access the context after stop + IOProc destruction.
    drop(unsafe { Box::from_raw(context_ptr) });
}

unsafe extern "C-unwind" fn application_capture_io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input_data: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output_data: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client_data: *mut c_void,
) -> i32 {
    let Some(context_ptr) = NonNull::new(client_data.cast::<IoContext>()) else {
        return NO_ERR;
    };
    // SAFETY: the worker owns this allocation and keeps it alive until after IO is destroyed.
    let context = unsafe { context_ptr.as_ptr().as_mut() };
    let Some(context) = context else {
        return NO_ERR;
    };
    // SAFETY: Core Audio passes a valid AudioBufferList for the callback duration.
    let buffers = unsafe { audio_buffers(input_data) };
    if buffers.is_empty() {
        return NO_ERR;
    }
    // SAFETY: every sample slice below is bounded by the byte sizes provided in the buffer list.
    unsafe { push_audio_buffers(context, buffers) };
    NO_ERR
}

unsafe fn audio_buffers<'a>(list: NonNull<AudioBufferList>) -> &'a [AudioBuffer] {
    // SAFETY: the callback guarantees a valid list whose flexible array has mNumberBuffers items.
    let list = unsafe { list.as_ref() };
    let count = usize::try_from(list.mNumberBuffers).unwrap_or(0);
    // SAFETY: AudioBufferList's trailing array is allocated by Core Audio for `count` buffers.
    unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), count) }
}

unsafe fn push_audio_buffers(context: &mut IoContext, buffers: &[AudioBuffer]) {
    if context.format.non_interleaved {
        // SAFETY: the caller validated the tap format and Core Audio owns this callback buffer.
        let left = unsafe { float_samples(&buffers[0]) };
        let right = if let Some(buffer) = buffers.get(1) {
            // SAFETY: this is another buffer from the same validated callback buffer list.
            unsafe { float_samples(buffer) }
        } else {
            left
        };
        let frames = left.len().min(right.len());
        for index in 0..frames {
            push_frame(context, [left[index], right[index]]);
        }
        return;
    }
    // SAFETY: the caller validated the tap format and Core Audio owns this callback buffer.
    let samples = unsafe { float_samples(&buffers[0]) };
    let channels = usize::try_from(context.format.channels).unwrap_or(1).max(1);
    let frame_bytes = context
        .format
        .bytes_per_frame
        .max(channels.saturating_mul(4));
    let frames = usize::try_from(buffers[0].mDataByteSize).unwrap_or(0) / frame_bytes;
    for index in 0..frames {
        let offset = index.saturating_mul(channels);
        let left = samples.get(offset).copied().unwrap_or(0.0);
        let right = if channels > 1 {
            samples.get(offset + 1).copied().unwrap_or(left)
        } else {
            left
        };
        push_frame(context, [left, right]);
    }
}

unsafe fn float_samples(buffer: &AudioBuffer) -> &[f32] {
    if buffer.mData.is_null() {
        return &[];
    }
    let len = usize::try_from(buffer.mDataByteSize).unwrap_or(0) / mem::size_of::<f32>();
    // SAFETY: Float32 format validation and mDataByteSize establish this slice's layout and bounds.
    unsafe { std::slice::from_raw_parts(buffer.mData.cast::<f32>(), len) }
}

fn push_frame(context: &mut IoContext, frame: ApplicationCaptureFrame) {
    if context.producer.try_push(frame).is_err() {
        context
            .state
            .counters
            .overflow_frames
            .fetch_add(1, Ordering::Relaxed);
        context
            .state
            .counters
            .dropout_frames
            .fetch_add(1, Ordering::Relaxed);
    }
}

fn process_is_running(process_id: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(process_id) else {
        return false;
    };
    // SAFETY: signal 0 performs a read-only process-existence check.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn status_for_os_status(status: i32) -> u32 {
    if status == kAudioDevicePermissionsError {
        APPLICATION_CAPTURE_STATUS_PERMISSION_DENIED
    } else {
        APPLICATION_CAPTURE_STATUS_ERROR
    }
}

fn platform_status(operation: &str, status: i32) -> ApplicationCaptureError {
    ApplicationCaptureError::Platform(format!("{operation} failed with OSStatus {status}"))
}

#[cfg(test)]
mod tests {
    use ringbuf::{
        HeapRb,
        traits::{Consumer, Split},
    };

    use super::*;

    fn test_state() -> Arc<ApplicationCaptureState> {
        Arc::new(ApplicationCaptureState::new(
            ApplicationCaptureTargetDescriptor {
                runtime_id: "macos-test".to_owned(),
                process_id: 1,
                display_name: "Test".to_owned(),
                executable_path: "/Applications/Test.app/Contents/MacOS/Test".to_owned(),
                logical_target: ApplicationCaptureLogicalTarget {
                    platform: "macos".to_owned(),
                    bundle_identifier: Some("com.example.test".to_owned()),
                    executable_path: "/Applications/Test.app/Contents/MacOS/Test".to_owned(),
                    executable_name: "Test".to_owned(),
                    include_process_tree: true,
                },
                channel_count: 2,
                status: "inactive".to_owned(),
            },
            crate::application_capture::APPLICATION_CAPTURE_STATUS_INACTIVE,
        ))
    }

    #[test]
    fn logical_identity_prefers_bundle_identifier() {
        let target = ApplicationCaptureLogicalTarget {
            platform: "macos".to_owned(),
            bundle_identifier: Some("com.example.Player".to_owned()),
            executable_path: "/Applications/Player.app/Contents/MacOS/Player".to_owned(),
            executable_name: "Player".to_owned(),
            include_process_tree: true,
        };
        let mut moved = target.clone();
        moved.executable_path = "/Volumes/Apps/Player.app/Contents/MacOS/Player".to_owned();
        assert!(logical_target_matches(&target, &moved));
    }

    #[test]
    fn permission_status_is_structured() {
        assert_eq!(
            status_for_os_status(kAudioDevicePermissionsError),
            APPLICATION_CAPTURE_STATUS_PERMISSION_DENIED
        );
    }

    #[test]
    fn helper_bundle_paths_are_not_root_applications() {
        assert!(!is_root_application_executable(
            "/Applications/Browser.app/Contents/Frameworks/Browser Helper.app/Contents/MacOS/Browser Helper"
        ));
        assert!(is_root_application_executable(
            "/Applications/Browser.app/Contents/MacOS/Browser"
        ));
    }

    #[test]
    fn io_layout_conversion_uses_first_two_channels_and_duplicates_mono() {
        let (producer, mut consumer) = HeapRb::<ApplicationCaptureFrame>::new(4).split();
        let mut interleaved = [0.25_f32, -0.5, 0.75, 1.0];
        let buffer = AudioBuffer {
            mNumberChannels: 4,
            mDataByteSize: u32::try_from(mem::size_of_val(&interleaved)).unwrap(),
            mData: interleaved.as_mut_ptr().cast(),
        };
        let mut context = IoContext {
            producer,
            state: test_state(),
            format: TapFormat {
                sample_rate: 48_000.0,
                channels: 4,
                non_interleaved: false,
                bytes_per_frame: 16,
            },
        };
        // SAFETY: the test buffer is live Float32 storage matching the declared format.
        unsafe { push_audio_buffers(&mut context, std::slice::from_ref(&buffer)) };
        assert_eq!(consumer.try_pop(), Some([0.25, -0.5]));

        let (producer, mut consumer) = HeapRb::<ApplicationCaptureFrame>::new(4).split();
        let mut mono = [0.125_f32, -0.25];
        let buffer = AudioBuffer {
            mNumberChannels: 1,
            mDataByteSize: u32::try_from(mem::size_of_val(&mono)).unwrap(),
            mData: mono.as_mut_ptr().cast(),
        };
        let mut context = IoContext {
            producer,
            state: test_state(),
            format: TapFormat {
                sample_rate: 48_000.0,
                channels: 1,
                non_interleaved: true,
                bytes_per_frame: 4,
            },
        };
        // SAFETY: the test buffer is live Float32 storage matching the declared format.
        unsafe { push_audio_buffers(&mut context, std::slice::from_ref(&buffer)) };
        assert_eq!(consumer.try_pop(), Some([0.125, 0.125]));
        assert_eq!(consumer.try_pop(), Some([-0.25, -0.25]));
    }
}
