use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_void},
    path::Path,
    ptr::NonNull,
};

use libloading::Library;
use yadaw_dsp_runtime::protocol::{
    ControlCommand, ControlResult, ParameterGesture, PluginParameter,
};

const INFINITE_TAIL: u32 = u32::MAX;

#[repr(C)]
#[derive(Clone, Copy)]
struct ParameterInfo {
    id: u32,
    default_normalized: f64,
    normalized: f64,
    step_count: i32,
    flags: u32,
    title: [c_char; 128],
    units: [c_char; 128],
}

type CreateFn =
    unsafe extern "C" fn(*const c_char, *const c_char, f64, u32, *mut c_char, usize) -> *mut c_void;
type DestroyFn = unsafe extern "C" fn(*mut c_void);
type SetParameterFn = unsafe extern "C" fn(*mut c_void, u32, f64, u32) -> i32;
type FlushParametersFn = unsafe extern "C" fn(*mut c_void) -> i32;
type ParameterCountFn = unsafe extern "C" fn(*const c_void) -> u32;
type ParameterInfoFn = unsafe extern "C" fn(*const c_void, u32, *mut ParameterInfo) -> i32;
type SamplesFn = unsafe extern "C" fn(*const c_void) -> u32;
type StateSizeFn = unsafe extern "C" fn(*mut c_void) -> usize;
type StateCopyFn = unsafe extern "C" fn(*mut c_void, *mut u8, usize) -> usize;
type RestoreStateFn = unsafe extern "C" fn(*mut c_void, *const u8, usize, *const u8, usize) -> i32;

#[derive(Clone, Copy)]
struct Functions {
    create: CreateFn,
    destroy: DestroyFn,
    set_parameter: SetParameterFn,
    flush_parameters: FlushParametersFn,
    parameter_count: ParameterCountFn,
    parameter_info: ParameterInfoFn,
    latency_samples: SamplesFn,
    tail_samples: SamplesFn,
    component_state_size: StateSizeFn,
    controller_state_size: StateSizeFn,
    copy_component_state: StateCopyFn,
    copy_controller_state: StateCopyFn,
    restore_state: RestoreStateFn,
}

pub struct Vst3Runtime {
    instances: HashMap<String, Instance>,
    _library: Library,
    functions: Functions,
}

struct Instance {
    pointer: NonNull<c_void>,
    functions: Functions,
}

impl Drop for Instance {
    fn drop(&mut self) {
        // SAFETY: The pointer was returned by the matching bridge create function and is owned here.
        unsafe { (self.functions.destroy)(self.pointer.as_ptr()) };
    }
}

impl Vst3Runtime {
    pub fn load(path: &Path) -> Result<Self, String> {
        // SAFETY: The bridge path is application-owned and all symbols are copied while the
        // library handle remains stored in this runtime.
        let library = unsafe { Library::new(path) }.map_err(|error| error.to_string())?;
        let functions = unsafe {
            Functions {
                create: *library
                    .get(b"yadaw_vst3_create\0")
                    .map_err(|error| error.to_string())?,
                destroy: *library
                    .get(b"yadaw_vst3_destroy\0")
                    .map_err(|error| error.to_string())?,
                set_parameter: *library
                    .get(b"yadaw_vst3_set_parameter\0")
                    .map_err(|error| error.to_string())?,
                flush_parameters: *library
                    .get(b"yadaw_vst3_flush_parameters\0")
                    .map_err(|error| error.to_string())?,
                parameter_count: *library
                    .get(b"yadaw_vst3_parameter_count\0")
                    .map_err(|error| error.to_string())?,
                parameter_info: *library
                    .get(b"yadaw_vst3_parameter_info\0")
                    .map_err(|error| error.to_string())?,
                latency_samples: *library
                    .get(b"yadaw_vst3_latency_samples\0")
                    .map_err(|error| error.to_string())?,
                tail_samples: *library
                    .get(b"yadaw_vst3_tail_samples\0")
                    .map_err(|error| error.to_string())?,
                component_state_size: *library
                    .get(b"yadaw_vst3_component_state_size\0")
                    .map_err(|error| error.to_string())?,
                controller_state_size: *library
                    .get(b"yadaw_vst3_controller_state_size\0")
                    .map_err(|error| error.to_string())?,
                copy_component_state: *library
                    .get(b"yadaw_vst3_copy_component_state\0")
                    .map_err(|error| error.to_string())?,
                copy_controller_state: *library
                    .get(b"yadaw_vst3_copy_controller_state\0")
                    .map_err(|error| error.to_string())?,
                restore_state: *library
                    .get(b"yadaw_vst3_restore_state\0")
                    .map_err(|error| error.to_string())?,
            }
        };
        Ok(Self {
            instances: HashMap::new(),
            _library: library,
            functions,
        })
    }

    pub fn execute(&mut self, command: ControlCommand) -> ControlResult {
        match command {
            ControlCommand::LoadPlugin {
                instance_id,
                module_path,
                class_id,
                sample_rate,
                component_state,
                controller_state,
            } => self.load_plugin(
                instance_id,
                module_path,
                class_id,
                sample_rate,
                component_state,
                controller_state,
            ),
            ControlCommand::UnloadPlugin { instance_id } => {
                self.instances.remove(&instance_id);
                ControlResult::Accepted
            }
            ControlCommand::PluginParameters { instance_id } => {
                self.plugin_parameters(&instance_id)
            }
            ControlCommand::SetPluginParameter {
                instance_id,
                parameter_id,
                normalized,
                gesture,
            } => self.set_parameter(&instance_id, parameter_id, normalized, gesture),
            ControlCommand::SavePluginState { instance_id } => self.save_state(&instance_id),
            _ => ControlResult::Error {
                message: "command is not a VST3 runtime command".into(),
            },
        }
    }

    fn load_plugin(
        &mut self,
        instance_id: String,
        module_path: String,
        class_id: String,
        sample_rate: f64,
        component_state: Vec<u8>,
        controller_state: Vec<u8>,
    ) -> ControlResult {
        let module_path = match CString::new(module_path) {
            Ok(value) => value,
            Err(_) => return error("VST3 module path contains an embedded NUL"),
        };
        let class_id = match CString::new(class_id) {
            Ok(value) => value,
            Err(_) => return error("VST3 class ID contains an embedded NUL"),
        };
        let mut message = [0_i8; 1024];
        // SAFETY: All pointers are valid for the duration of the call and the bridge validates
        // configuration before constructing the owned opaque instance.
        let pointer = unsafe {
            (self.functions.create)(
                module_path.as_ptr(),
                class_id.as_ptr(),
                sample_rate,
                4096,
                message.as_mut_ptr(),
                message.len(),
            )
        };
        let Some(pointer) = NonNull::new(pointer) else {
            // SAFETY: The bridge always NUL-terminates the fixed error buffer.
            let message = unsafe { CStr::from_ptr(message.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            return error(if message.is_empty() {
                "VST3 instance creation failed"
            } else {
                &message
            });
        };
        let instance = Instance {
            pointer,
            functions: self.functions,
        };
        if !component_state.is_empty() {
            // SAFETY: State byte slices and the live opaque instance are valid for the call.
            let restored = unsafe {
                (self.functions.restore_state)(
                    pointer.as_ptr(),
                    component_state.as_ptr(),
                    component_state.len(),
                    controller_state.as_ptr(),
                    controller_state.len(),
                )
            };
            if restored == 0 {
                return error("VST3 state restoration failed");
            }
        }
        // SAFETY: The instance is live and owned by the map below.
        let latency_samples = unsafe { (self.functions.latency_samples)(pointer.as_ptr()) };
        let tail = unsafe { (self.functions.tail_samples)(pointer.as_ptr()) };
        self.instances.insert(instance_id, instance);
        ControlResult::PluginLoaded {
            latency_samples,
            tail_samples: (tail != INFINITE_TAIL).then_some(tail),
        }
    }

    fn plugin_parameters(&self, instance_id: &str) -> ControlResult {
        let Some(instance) = self.instances.get(instance_id) else {
            return error("VST3 instance is not loaded");
        };
        // SAFETY: The opaque instance remains live for every bridge query in this function.
        let count = unsafe { (self.functions.parameter_count)(instance.pointer.as_ptr()) };
        let mut parameters = Vec::with_capacity(count as usize);
        for index in 0..count {
            let mut info = ParameterInfo {
                id: 0,
                default_normalized: 0.0,
                normalized: 0.0,
                step_count: 0,
                flags: 0,
                title: [0; 128],
                units: [0; 128],
            };
            let valid = unsafe {
                (self.functions.parameter_info)(instance.pointer.as_ptr(), index, &mut info)
            };
            if valid == 0 {
                continue;
            }
            parameters.push(PluginParameter {
                id: info.id,
                title: c_string(&info.title),
                units: c_string(&info.units),
                step_count: info.step_count,
                default_normalized: info.default_normalized,
                normalized: info.normalized,
                flags: info.flags,
            });
        }
        ControlResult::PluginParameters { parameters }
    }

    fn set_parameter(
        &mut self,
        instance_id: &str,
        parameter_id: u32,
        normalized: f64,
        gesture: ParameterGesture,
    ) -> ControlResult {
        let Some(instance) = self.instances.get(instance_id) else {
            return error("VST3 instance is not loaded");
        };
        if !normalized.is_finite() || !(0.0..=1.0).contains(&normalized) {
            return error("VST3 parameter value is outside 0...1");
        }
        if gesture != ParameterGesture::Begin {
            let changed = unsafe {
                (self.functions.set_parameter)(
                    instance.pointer.as_ptr(),
                    parameter_id,
                    normalized,
                    0,
                )
            };
            if changed == 0 {
                return error("VST3 parameter change was rejected");
            }
        }
        if gesture == ParameterGesture::End {
            let flushed = unsafe { (self.functions.flush_parameters)(instance.pointer.as_ptr()) };
            if flushed == 0 {
                return error("VST3 stopped-state parameter flush failed");
            }
        }
        ControlResult::Accepted
    }

    fn save_state(&mut self, instance_id: &str) -> ControlResult {
        let Some(instance) = self.instances.get(instance_id) else {
            return error("VST3 instance is not loaded");
        };
        let component_state = copy_state(
            instance.pointer,
            self.functions.component_state_size,
            self.functions.copy_component_state,
        );
        let controller_state = copy_state(
            instance.pointer,
            self.functions.controller_state_size,
            self.functions.copy_controller_state,
        );
        ControlResult::PluginState {
            component_state,
            controller_state,
        }
    }
}

fn copy_state(pointer: NonNull<c_void>, size: StateSizeFn, copy: StateCopyFn) -> Vec<u8> {
    // SAFETY: The opaque instance is live and the returned size is used to allocate the
    // destination passed directly back to the same bridge.
    let length = unsafe { size(pointer.as_ptr()) };
    let mut state = vec![0; length];
    if length > 0 {
        let copied = unsafe { copy(pointer.as_ptr(), state.as_mut_ptr(), state.len()) };
        state.truncate(copied);
    }
    state
}

fn c_string(value: &[c_char]) -> String {
    let length = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    let bytes = value[..length]
        .iter()
        .map(|character| *character as u8)
        .collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn error(message: &str) -> ControlResult {
    ControlResult::Error {
        message: message.into(),
    }
}
