//! Type-safe ownership and lifecycle wrappers for hosted VST3 plug-ins.

#![deny(unsafe_op_in_unsafe_fn)]

mod ara;
mod com;
mod component_handler;
mod error;
mod event_list;
mod frame;
mod host_context;
mod host_objects;
mod hosted;
mod id;
mod module;
mod output_parameter_bridge;
mod parameter_changes;
mod processor;
mod processor_handle;
mod stream;

pub use ara::{AraMainFactory, AraPluginEntry};
pub use com::{ComInterface, ComPtr};
pub use component_handler::{EditorParameterGesture, Vst3HostRequest, Vst3RestartRequest};
pub use error::{HostError, HostResult};
pub use frame::PlugFrame;
pub use heron_vst3_host_sys::Steinberg::ViewRect;
pub use hosted::{
    HostedParameter, HostedPlugin, HostedProgramList, HostedUnit, HostedUnitInfo, PlugView,
    ProcessorLease,
};
pub use id::ClassId;
pub use module::{AraFactoryInfo, ClassInfo, FactoryInfo, Module};
pub use processor::{
    AudioBusDescriptor, AudioBusDirection, AudioBusKind, AudioLayout, HostProcessContext,
    PluginKind, StereoProcessor,
};
pub use processor_handle::{Vst3AuxInputConfig, Vst3ProcessorHandle, Vst3SidechainBlock};
