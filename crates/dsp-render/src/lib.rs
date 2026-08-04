//! Runtime-agnostic audio graph rendering shared by real-time and future
//! offline hosts.
//!
//! Building may allocate and clone resources. Rendering never performs I/O,
//! locks, allocation, or deallocation.

mod resources;
mod runtime;
mod spec;

pub use heron_audio_plugin::{
    AudioPluginProcessor, AudioPluginProcessorHandle, ParameterToken, ProcessContext,
    SidechainSource,
};
pub use resources::{AudioClipSource, RenderResources};
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
