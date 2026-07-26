//! Type-safe ownership and lifecycle wrappers for hosted VST3 plug-ins.

#![deny(unsafe_op_in_unsafe_fn)]

mod com;
mod error;
mod event_list;
mod host_context;
mod id;
mod module;
mod processor;

pub use com::{ComInterface, ComPtr};
pub use error::{HostError, HostResult};
pub use id::ClassId;
pub use module::{ClassInfo, Module};
pub use processor::{PluginKind, StereoProcessor};
