//! Type-safe ownership and lifecycle wrappers for hosted VST3 plug-ins.

#![deny(unsafe_op_in_unsafe_fn)]

mod com;
mod component_handler;
mod error;
mod event_list;
mod frame;
mod host_context;
mod hosted;
mod id;
mod module;
mod parameter_changes;
mod processor;
mod stream;

pub use com::{ComInterface, ComPtr};
pub use error::{HostError, HostResult};
pub use frame::PlugFrame;
pub use hosted::{HostedParameter, HostedPlugin, PlugView, ProcessorLease};
pub use id::ClassId;
pub use module::{ClassInfo, Module};
pub use processor::{HostProcessContext, PluginKind, StereoProcessor};
pub use yadaw_vst3_host_sys::Steinberg::ViewRect;
