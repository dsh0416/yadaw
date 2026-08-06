//! Audited CLAP ABI boundary for Heron's in-process audio plug-in runtime.

mod host;
mod instance;
mod module;
mod processor;

pub use host::{ClapHostRequests, HostRequestSnapshot};
pub use instance::{
    ClapAudioPort, ClapAudioPortConfig, ClapInstance, ClapInstanceError, ClapLifecycleState,
    ClapNotePort, ClapParameter,
};
pub use module::{ClapDescriptor, ClapModule, ClapModuleError};
pub use processor::{ClapParameterGesture, ClapProcessorHandle};
