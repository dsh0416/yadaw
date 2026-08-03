//! Runtime-agnostic audio graph rendering shared by real-time and future
//! offline hosts.
//!
//! Building may allocate and clone resources. Rendering never performs I/O,
//! locks, allocation, or deallocation.

mod resources;
mod runtime;
mod spec;

pub use resources::{AudioClipSource, PluginProcessContext, PluginProcessor, RenderResources};
pub use runtime::{
    RenderBuildError, RenderDiagnosticSnapshot, RenderMeter, RenderRuntime, RenderTransport,
};
pub use spec::{
    RenderChannelKind, RenderChannelSpec, RenderClipSpec, RenderGraphSpec, RenderMidiNote,
    RenderMidiSpec, RenderPluginSpec, RenderRoute, RenderSendSpec, RenderSendTap,
};

pub use heron_dsp_core::mixer::{HardwareOutputFrame, StereoFrame};
pub use heron_dsp_runtime::tempo::{TempoEvent, TempoMap, TimeSignatureEvent};

#[cfg(test)]
mod tests;
