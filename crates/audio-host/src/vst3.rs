use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_void},
    path::Path,
    ptr::NonNull,
};

use libloading::Library;
use yadaw_dsp_runtime::protocol::{
    BinaryPayload, ControlCommand, ControlResult, ParameterCommand, ParameterGesture,
    PluginParameter,
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
type OpenEditorFn = unsafe extern "C" fn(*mut c_void) -> i32;
type CloseEditorFn = unsafe extern "C" fn(*mut c_void);
type EditorOpenFn = unsafe extern "C" fn(*const c_void) -> i32;
type ConsumeChangedFn = unsafe extern "C" fn(*mut c_void) -> i32;
type PumpEditorEventsFn = unsafe extern "C" fn();
type ProcessStereoFn = unsafe extern "C" fn(
    *mut c_void,
    *const f32,
    *const f32,
    *mut f32,
    *mut f32,
    u32,
    *const ProcessContext,
) -> i32;
type NoteFn = unsafe extern "C" fn(*mut c_void, i16, i16, i16, f32, i32, i32) -> i32;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ProcessContext {
    pub project_time_samples: i64,
    pub continuous_time_samples: i64,
    pub project_time_quarters: f64,
    pub bar_position_quarters: f64,
    pub tempo: f64,
    pub time_signature_numerator: i32,
    pub time_signature_denominator: i32,
    pub playing: u8,
    pub recording: u8,
}

#[derive(Clone, Copy)]
struct Functions {
    create: CreateFn,
    destroy: DestroyFn,
    process_stereo: ProcessStereoFn,
    note_on: NoteFn,
    note_off: NoteFn,
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
    open_editor: OpenEditorFn,
    close_editor: CloseEditorFn,
    editor_open: EditorOpenFn,
    consume_latency_changed: ConsumeChangedFn,
    pump_editor_events: PumpEditorEventsFn,
}

#[derive(Clone, Copy)]
pub struct Vst3ProcessorHandle {
    pointer: NonNull<c_void>,
    functions: Functions,
}

// The bridge instance is created on the helper control thread and processed only by the
// helper audio thread. Its controller entry points are required by VST3 to be callable from
// the host UI/control thread.
unsafe impl Send for Vst3ProcessorHandle {}
unsafe impl Sync for Vst3ProcessorHandle {}

impl Vst3ProcessorHandle {
    pub fn process_frame(&self, input: [f32; 2], context: &ProcessContext) -> Option<[f32; 2]> {
        let mut left = 0.0_f32;
        let mut right = 0.0_f32;
        // SAFETY: The instance remains owned by Vst3Runtime for the helper lifetime, and all
        // buffers contain exactly the single frame advertised to the bridge.
        let processed = unsafe {
            (self.functions.process_stereo)(
                self.pointer.as_ptr(),
                &input[0],
                &input[1],
                &mut left,
                &mut right,
                1,
                context,
            )
        };
        (processed != 0).then_some([left, right])
    }

    pub fn note_on(&self, channel: u8, key: u8, velocity: u8, note_id: i32) -> bool {
        // SAFETY: The bridge copies the event into its preallocated input event list.
        unsafe {
            (self.functions.note_on)(
                self.pointer.as_ptr(),
                0,
                i16::from(channel),
                i16::from(key),
                f32::from(velocity) / 127.0,
                note_id,
                0,
            ) != 0
        }
    }

    pub fn note_off(&self, channel: u8, key: u8, velocity: u8, note_id: i32) -> bool {
        // SAFETY: The bridge copies the event into its preallocated input event list.
        unsafe {
            (self.functions.note_off)(
                self.pointer.as_ptr(),
                0,
                i16::from(channel),
                i16::from(key),
                f32::from(velocity) / 127.0,
                note_id,
                0,
            ) != 0
        }
    }
}

pub struct Vst3Runtime {
    instances: HashMap<String, Instance>,
    next_runtime_handle: u32,
    _library: Library,
    functions: Functions,
}

struct Instance {
    pointer: NonNull<c_void>,
    runtime_handle: u32,
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
                process_stereo: *library
                    .get(b"yadaw_vst3_process_stereo\0")
                    .map_err(|error| error.to_string())?,
                note_on: *library
                    .get(b"yadaw_vst3_note_on\0")
                    .map_err(|error| error.to_string())?,
                note_off: *library
                    .get(b"yadaw_vst3_note_off\0")
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
                open_editor: *library
                    .get(b"yadaw_vst3_open_editor\0")
                    .map_err(|error| error.to_string())?,
                close_editor: *library
                    .get(b"yadaw_vst3_close_editor\0")
                    .map_err(|error| error.to_string())?,
                editor_open: *library
                    .get(b"yadaw_vst3_editor_open\0")
                    .map_err(|error| error.to_string())?,
                consume_latency_changed: *library
                    .get(b"yadaw_vst3_consume_latency_changed\0")
                    .map_err(|error| error.to_string())?,
                pump_editor_events: *library
                    .get(b"yadaw_vst3_pump_editor_events\0")
                    .map_err(|error| error.to_string())?,
            }
        };
        Ok(Self {
            instances: HashMap::new(),
            next_runtime_handle: 1,
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
            ControlCommand::UnloadPlugin { .. } => {
                // Realtime graphs hold stable bridge handles and are retired asynchronously.
                // Keep the instance alive until helper shutdown rather than invalidating a
                // pointer that an outgoing callback generation may still be using.
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
            ControlCommand::OpenPluginEditor { instance_id } => self.open_editor(&instance_id),
            ControlCommand::ClosePluginEditor { instance_id } => self.close_editor(&instance_id),
            _ => ControlResult::Error {
                message: "command is not a VST3 runtime command".into(),
            },
        }
    }

    pub fn processor_handle(&self, instance_id: &str) -> Option<Vst3ProcessorHandle> {
        self.instances
            .get(instance_id)
            .map(|instance| Vst3ProcessorHandle {
                pointer: instance.pointer,
                functions: instance.functions,
            })
    }

    pub fn apply_parameter_command(&mut self, command: ParameterCommand) -> ControlResult {
        let instance_id = self.instances.iter().find_map(|(id, instance)| {
            (instance.runtime_handle == command.runtime_handle).then(|| id.clone())
        });
        match instance_id {
            Some(instance_id) => self.set_parameter(
                &instance_id,
                command.parameter_id,
                command.normalized,
                command.gesture,
            ),
            None => error("VST3 runtime handle is stale"),
        }
    }

    pub fn take_timing_changes(&self) -> Vec<(String, u32, Option<u32>)> {
        self.instances
            .iter()
            .filter_map(|(id, instance)| {
                let changed = unsafe {
                    (self.functions.consume_latency_changed)(instance.pointer.as_ptr()) != 0
                };
                changed.then(|| {
                    let latency =
                        unsafe { (self.functions.latency_samples)(instance.pointer.as_ptr()) };
                    let tail = unsafe { (self.functions.tail_samples)(instance.pointer.as_ptr()) };
                    (id.clone(), latency, (tail != INFINITE_TAIL).then_some(tail))
                })
            })
            .collect()
    }

    pub fn pump_editor_events(&self) {
        unsafe { (self.functions.pump_editor_events)() };
    }

    fn load_plugin(
        &mut self,
        instance_id: String,
        module_path: String,
        class_id: String,
        sample_rate: f64,
        component_state: BinaryPayload,
        controller_state: BinaryPayload,
    ) -> ControlResult {
        let component_state = match component_state {
            BinaryPayload::Inline { bytes } => bytes,
            BinaryPayload::Shared { .. } => {
                return error("shared VST3 component state was not materialized");
            }
        };
        let controller_state = match controller_state {
            BinaryPayload::Inline { bytes } => bytes,
            BinaryPayload::Shared { .. } => {
                return error("shared VST3 controller state was not materialized");
            }
        };
        if let Some(instance) = self.instances.get(&instance_id) {
            // Graph rebuilds deliberately reuse the existing processor and editor instance.
            let latency_samples =
                unsafe { (self.functions.latency_samples)(instance.pointer.as_ptr()) };
            let tail = unsafe { (self.functions.tail_samples)(instance.pointer.as_ptr()) };
            return ControlResult::PluginLoaded {
                runtime_handle: instance.runtime_handle,
                latency_samples,
                tail_samples: (tail != INFINITE_TAIL).then_some(tail),
            };
        }
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
            runtime_handle: self.next_runtime_handle,
            functions: self.functions,
        };
        self.next_runtime_handle = self.next_runtime_handle.wrapping_add(1).max(1);
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
        let runtime_handle = instance.runtime_handle;
        self.instances.insert(instance_id, instance);
        ControlResult::PluginLoaded {
            runtime_handle,
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
            component_state: BinaryPayload::inline(component_state),
            controller_state: BinaryPayload::inline(controller_state),
        }
    }

    fn open_editor(&self, instance_id: &str) -> ControlResult {
        let Some(instance) = self.instances.get(instance_id) else {
            return error("VST3 instance is not loaded");
        };
        let open = unsafe { (self.functions.open_editor)(instance.pointer.as_ptr()) != 0 };
        ControlResult::PluginEditor {
            editor_kind: if open { "native" } else { "generic" }.into(),
            open,
        }
    }

    fn close_editor(&self, instance_id: &str) -> ControlResult {
        let Some(instance) = self.instances.get(instance_id) else {
            return ControlResult::Accepted;
        };
        unsafe { (self.functions.close_editor)(instance.pointer.as_ptr()) };
        ControlResult::PluginEditor {
            editor_kind: "native".into(),
            open: unsafe { (self.functions.editor_open)(instance.pointer.as_ptr()) != 0 },
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
