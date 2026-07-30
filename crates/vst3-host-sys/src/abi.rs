//! Rust declarations for the C++ VST3 interface vtables.
//!
//! Bindgen supplies the target-specific object and POD layouts. It does not
//! emit complete inherited virtual tables for these abstract interfaces, so
//! the method tables below mirror the declaration order in VST3 SDK 3.8.0.

use std::{ffi::c_void, os::raw::c_char};

use crate::Steinberg::{
    self, FIDString, FUnknown, IBStream, IPlugFrame, IPlugView, IPlugViewContentScaleSupport,
    IPluginBase, IPluginFactory, IPluginFactory2, IPluginFactory3, PClassInfo, PClassInfo2,
    PClassInfoW, PFactoryInfo, TBool, TUID, ViewRect,
    Vst::{
        AudioBusBuffers, BusDirection, BusInfo, CtrlNumber, Event, IAudioProcessor, IComponent,
        IComponentHandler, IConnectionPoint, IEditController, IEventList, IHostApplication,
        IMessage, IMidiMapping, IParamValueQueue, IParameterChanges, IoMode, MediaType, ParamID,
        ParamValue, ParameterInfo, ProcessData, ProcessSetup, RoutingInfo, SpeakerArrangement,
    },
    int16, int32, int64, tresult, uint32,
};

pub type QueryInterface = unsafe extern "system" fn(
    this: *mut FUnknown,
    iid: *const c_char,
    object: *mut *mut c_void,
) -> tresult;
pub type AddRef = unsafe extern "system" fn(this: *mut FUnknown) -> uint32;
pub type Release = unsafe extern "system" fn(this: *mut FUnknown) -> uint32;

#[repr(C)]
pub struct FUnknownVTable {
    pub query_interface: QueryInterface,
    pub add_ref: AddRef,
    pub release: Release,
}

#[repr(C)]
pub struct PluginBaseVTable {
    pub base: FUnknownVTable,
    pub initialize:
        unsafe extern "system" fn(this: *mut IPluginBase, context: *mut FUnknown) -> tresult,
    pub terminate: unsafe extern "system" fn(this: *mut IPluginBase) -> tresult,
}

#[repr(C)]
pub struct PluginFactoryVTable {
    pub base: FUnknownVTable,
    pub get_factory_info:
        unsafe extern "system" fn(this: *mut IPluginFactory, info: *mut PFactoryInfo) -> tresult,
    pub count_classes: unsafe extern "system" fn(this: *mut IPluginFactory) -> int32,
    pub get_class_info: unsafe extern "system" fn(
        this: *mut IPluginFactory,
        index: int32,
        info: *mut PClassInfo,
    ) -> tresult,
    pub create_instance: unsafe extern "system" fn(
        this: *mut IPluginFactory,
        class_id: FIDString,
        interface_id: FIDString,
        object: *mut *mut c_void,
    ) -> tresult,
}

#[repr(C)]
pub struct PluginFactory2VTable {
    pub base: PluginFactoryVTable,
    pub get_class_info2: unsafe extern "system" fn(
        this: *mut IPluginFactory2,
        index: int32,
        info: *mut PClassInfo2,
    ) -> tresult,
}

#[repr(C)]
pub struct PluginFactory3VTable {
    pub base: PluginFactory2VTable,
    pub get_class_info_unicode: unsafe extern "system" fn(
        this: *mut IPluginFactory3,
        index: int32,
        info: *mut PClassInfoW,
    ) -> tresult,
    pub set_host_context:
        unsafe extern "system" fn(this: *mut IPluginFactory3, context: *mut FUnknown) -> tresult,
}

#[repr(C)]
pub struct StreamVTable {
    pub base: FUnknownVTable,
    pub read: unsafe extern "system" fn(
        this: *mut IBStream,
        buffer: *mut c_void,
        byte_count: int32,
        bytes_read: *mut int32,
    ) -> tresult,
    pub write: unsafe extern "system" fn(
        this: *mut IBStream,
        buffer: *mut c_void,
        byte_count: int32,
        bytes_written: *mut int32,
    ) -> tresult,
    pub seek: unsafe extern "system" fn(
        this: *mut IBStream,
        position: int64,
        mode: int32,
        result: *mut int64,
    ) -> tresult,
    pub tell: unsafe extern "system" fn(this: *mut IBStream, position: *mut int64) -> tresult,
}

#[repr(C)]
pub struct ComponentVTable {
    pub base: PluginBaseVTable,
    pub get_controller_class_id:
        unsafe extern "system" fn(this: *mut IComponent, class_id: *mut c_char) -> tresult,
    pub set_io_mode: unsafe extern "system" fn(this: *mut IComponent, mode: IoMode) -> tresult,
    pub get_bus_count: unsafe extern "system" fn(
        this: *mut IComponent,
        media_type: MediaType,
        direction: BusDirection,
    ) -> int32,
    pub get_bus_info: unsafe extern "system" fn(
        this: *mut IComponent,
        media_type: MediaType,
        direction: BusDirection,
        index: int32,
        info: *mut BusInfo,
    ) -> tresult,
    pub get_routing_info: unsafe extern "system" fn(
        this: *mut IComponent,
        input: *mut RoutingInfo,
        output: *mut RoutingInfo,
    ) -> tresult,
    pub activate_bus: unsafe extern "system" fn(
        this: *mut IComponent,
        media_type: MediaType,
        direction: BusDirection,
        index: int32,
        state: TBool,
    ) -> tresult,
    pub set_active: unsafe extern "system" fn(this: *mut IComponent, state: TBool) -> tresult,
    pub set_state:
        unsafe extern "system" fn(this: *mut IComponent, stream: *mut IBStream) -> tresult,
    pub get_state:
        unsafe extern "system" fn(this: *mut IComponent, stream: *mut IBStream) -> tresult,
}

#[repr(C)]
pub struct AudioProcessorVTable {
    pub base: FUnknownVTable,
    pub set_bus_arrangements: unsafe extern "system" fn(
        this: *mut IAudioProcessor,
        inputs: *mut SpeakerArrangement,
        input_count: int32,
        outputs: *mut SpeakerArrangement,
        output_count: int32,
    ) -> tresult,
    pub get_bus_arrangement: unsafe extern "system" fn(
        this: *mut IAudioProcessor,
        direction: BusDirection,
        index: int32,
        arrangement: *mut SpeakerArrangement,
    ) -> tresult,
    pub can_process_sample_size:
        unsafe extern "system" fn(this: *mut IAudioProcessor, symbolic_size: int32) -> tresult,
    pub latency_samples: unsafe extern "system" fn(this: *mut IAudioProcessor) -> uint32,
    pub setup_processing:
        unsafe extern "system" fn(this: *mut IAudioProcessor, setup: *mut ProcessSetup) -> tresult,
    pub set_processing:
        unsafe extern "system" fn(this: *mut IAudioProcessor, state: TBool) -> tresult,
    pub process:
        unsafe extern "system" fn(this: *mut IAudioProcessor, data: *mut ProcessData) -> tresult,
    pub tail_samples: unsafe extern "system" fn(this: *mut IAudioProcessor) -> uint32,
}

#[repr(C)]
pub struct EditControllerVTable {
    pub base: PluginBaseVTable,
    pub set_component_state:
        unsafe extern "system" fn(this: *mut IEditController, stream: *mut IBStream) -> tresult,
    pub set_state:
        unsafe extern "system" fn(this: *mut IEditController, stream: *mut IBStream) -> tresult,
    pub get_state:
        unsafe extern "system" fn(this: *mut IEditController, stream: *mut IBStream) -> tresult,
    pub parameter_count: unsafe extern "system" fn(this: *mut IEditController) -> int32,
    pub parameter_info: unsafe extern "system" fn(
        this: *mut IEditController,
        index: int32,
        info: *mut ParameterInfo,
    ) -> tresult,
    pub parameter_string: unsafe extern "system" fn(
        this: *mut IEditController,
        id: ParamID,
        normalized: ParamValue,
        text: *mut u16,
    ) -> tresult,
    pub parameter_from_string: unsafe extern "system" fn(
        this: *mut IEditController,
        id: ParamID,
        text: *mut u16,
        normalized: *mut ParamValue,
    ) -> tresult,
    pub normalized_to_plain: unsafe extern "system" fn(
        this: *mut IEditController,
        id: ParamID,
        normalized: ParamValue,
    ) -> ParamValue,
    pub plain_to_normalized: unsafe extern "system" fn(
        this: *mut IEditController,
        id: ParamID,
        plain: ParamValue,
    ) -> ParamValue,
    pub parameter_normalized:
        unsafe extern "system" fn(this: *mut IEditController, id: ParamID) -> ParamValue,
    pub set_parameter_normalized: unsafe extern "system" fn(
        this: *mut IEditController,
        id: ParamID,
        value: ParamValue,
    ) -> tresult,
    pub set_component_handler: unsafe extern "system" fn(
        this: *mut IEditController,
        handler: *mut IComponentHandler,
    ) -> tresult,
    pub create_view:
        unsafe extern "system" fn(this: *mut IEditController, name: FIDString) -> *mut IPlugView,
}

#[repr(C)]
pub struct MidiMappingVTable {
    pub base: FUnknownVTable,
    pub get_midi_controller_assignment: unsafe extern "system" fn(
        this: *mut IMidiMapping,
        bus_index: int32,
        channel: int16,
        midi_controller_number: CtrlNumber,
        id: *mut ParamID,
    ) -> tresult,
}

#[repr(C)]
pub struct ComponentHandlerVTable {
    pub base: FUnknownVTable,
    pub begin_edit: unsafe extern "system" fn(this: *mut IComponentHandler, id: ParamID) -> tresult,
    pub perform_edit: unsafe extern "system" fn(
        this: *mut IComponentHandler,
        id: ParamID,
        normalized: ParamValue,
    ) -> tresult,
    pub end_edit: unsafe extern "system" fn(this: *mut IComponentHandler, id: ParamID) -> tresult,
    pub restart_component:
        unsafe extern "system" fn(this: *mut IComponentHandler, flags: int32) -> tresult,
}

#[repr(C)]
pub struct HostApplicationVTable {
    pub base: FUnknownVTable,
    pub get_name: unsafe extern "system" fn(this: *mut IHostApplication, name: *mut u16) -> tresult,
    pub create_instance: unsafe extern "system" fn(
        this: *mut IHostApplication,
        class_id: *mut c_char,
        interface_id: *mut c_char,
        object: *mut *mut c_void,
    ) -> tresult,
}

#[repr(C)]
pub struct EventListVTable {
    pub base: FUnknownVTable,
    pub event_count: unsafe extern "system" fn(this: *mut IEventList) -> int32,
    pub event: unsafe extern "system" fn(
        this: *mut IEventList,
        index: int32,
        event: *mut Event,
    ) -> tresult,
    pub add_event: unsafe extern "system" fn(this: *mut IEventList, event: *mut Event) -> tresult,
}

#[repr(C)]
pub struct ParamValueQueueVTable {
    pub base: FUnknownVTable,
    pub parameter_id: unsafe extern "system" fn(this: *mut IParamValueQueue) -> ParamID,
    pub point_count: unsafe extern "system" fn(this: *mut IParamValueQueue) -> int32,
    pub point: unsafe extern "system" fn(
        this: *mut IParamValueQueue,
        index: int32,
        sample_offset: *mut int32,
        value: *mut ParamValue,
    ) -> tresult,
    pub add_point: unsafe extern "system" fn(
        this: *mut IParamValueQueue,
        sample_offset: int32,
        value: ParamValue,
        index: *mut int32,
    ) -> tresult,
}

#[repr(C)]
pub struct ParameterChangesVTable {
    pub base: FUnknownVTable,
    pub parameter_count: unsafe extern "system" fn(this: *mut IParameterChanges) -> int32,
    pub parameter_data: unsafe extern "system" fn(
        this: *mut IParameterChanges,
        index: int32,
    ) -> *mut IParamValueQueue,
    pub add_parameter_data: unsafe extern "system" fn(
        this: *mut IParameterChanges,
        id: *const ParamID,
        index: *mut int32,
    ) -> *mut IParamValueQueue,
}

#[repr(C)]
pub struct ConnectionPointVTable {
    pub base: FUnknownVTable,
    pub connect: unsafe extern "system" fn(
        this: *mut IConnectionPoint,
        other: *mut IConnectionPoint,
    ) -> tresult,
    pub disconnect: unsafe extern "system" fn(
        this: *mut IConnectionPoint,
        other: *mut IConnectionPoint,
    ) -> tresult,
    pub notify:
        unsafe extern "system" fn(this: *mut IConnectionPoint, message: *mut IMessage) -> tresult,
}

#[repr(C)]
pub struct PlugViewVTable {
    pub base: FUnknownVTable,
    pub is_platform_type_supported:
        unsafe extern "system" fn(this: *mut IPlugView, platform: FIDString) -> tresult,
    pub attached: unsafe extern "system" fn(
        this: *mut IPlugView,
        parent: *mut c_void,
        platform: FIDString,
    ) -> tresult,
    pub removed: unsafe extern "system" fn(this: *mut IPlugView) -> tresult,
    pub on_wheel: unsafe extern "system" fn(this: *mut IPlugView, distance: f32) -> tresult,
    pub on_key_down: unsafe extern "system" fn(
        this: *mut IPlugView,
        key: u16,
        key_code: int16,
        modifiers: int16,
    ) -> tresult,
    pub on_key_up: unsafe extern "system" fn(
        this: *mut IPlugView,
        key: u16,
        key_code: int16,
        modifiers: int16,
    ) -> tresult,
    pub size: unsafe extern "system" fn(this: *mut IPlugView, size: *mut ViewRect) -> tresult,
    pub on_size: unsafe extern "system" fn(this: *mut IPlugView, size: *mut ViewRect) -> tresult,
    pub on_focus: unsafe extern "system" fn(this: *mut IPlugView, state: TBool) -> tresult,
    pub set_frame:
        unsafe extern "system" fn(this: *mut IPlugView, frame: *mut IPlugFrame) -> tresult,
    pub can_resize: unsafe extern "system" fn(this: *mut IPlugView) -> tresult,
    pub check_size_constraint:
        unsafe extern "system" fn(this: *mut IPlugView, size: *mut ViewRect) -> tresult,
}

#[repr(C)]
pub struct PlugFrameVTable {
    pub base: FUnknownVTable,
    pub resize_view: unsafe extern "system" fn(
        this: *mut IPlugFrame,
        view: *mut IPlugView,
        size: *mut ViewRect,
    ) -> tresult,
}

#[repr(C)]
pub struct PlugViewContentScaleSupportVTable {
    pub base: FUnknownVTable,
    pub set_content_scale_factor:
        unsafe extern "system" fn(this: *mut IPlugViewContentScaleSupport, factor: f32) -> tresult,
}

pub type GetPluginFactory = unsafe extern "system" fn() -> *mut IPluginFactory;
pub type InitDll = unsafe extern "system" fn() -> bool;
pub type ExitDll = unsafe extern "system" fn() -> bool;
pub type ModuleEntry = unsafe extern "system" fn(handle: *mut c_void) -> bool;
pub type ModuleExit = unsafe extern "system" fn() -> bool;

#[allow(dead_code)]
fn _assert_imports(_: *mut AudioBusBuffers, _: TUID, _: *mut Steinberg::FUnknown) {}
