use std::collections::HashMap;

use yadaw_dsp_core::mixer::StereoFrame;

/// Random-access decoded audio. Implementations must keep `sample` free of
/// blocking, I/O, locks, allocation, and deallocation.
pub trait AudioClipSource: Send + Sync {
    fn channels(&self) -> u32;
    fn frame_count(&self) -> u64;
    fn sample(&self, frame: u64, channel: u32) -> f32;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PluginProcessContext {
    pub sample_position: u64,
    pub quarter_position: f64,
    pub bar_position: f64,
    pub tempo: f64,
    pub time_signature_numerator: u8,
    pub time_signature_denominator: u8,
    pub playing: bool,
    pub recording: bool,
}

/// Format-neutral processor used by the render graph.
///
/// Processor cloning happens only while building a graph. Hosts adapt concrete
/// plug-in formats, such as VST3, behind this trait.
pub trait PluginProcessor: Send {
    fn clone_box(&self) -> Box<dyn PluginProcessor>;
    fn process_frame(&mut self, frame: StereoFrame, context: PluginProcessContext) -> StereoFrame;
    fn note_on(&mut self, channel: u8, key: u8, velocity: u8);
    fn note_off(&mut self, channel: u8, key: u8, velocity: u8);
    fn set_parameter(&mut self, _parameter_id: u32, _normalized: f64) {}
}

impl Clone for Box<dyn PluginProcessor> {
    fn clone(&self) -> Self {
        self.clone_box()
    }
}

#[derive(Default)]
pub struct RenderResources {
    clip_sources: HashMap<String, Box<dyn AudioClipSource>>,
    plugin_processors: HashMap<String, Box<dyn PluginProcessor>>,
}

impl RenderResources {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert_clip(
        &mut self,
        id: impl Into<String>,
        source: Box<dyn AudioClipSource>,
    ) -> Option<Box<dyn AudioClipSource>> {
        self.clip_sources.insert(id.into(), source)
    }

    pub fn insert_plugin(
        &mut self,
        id: impl Into<String>,
        processor: Box<dyn PluginProcessor>,
    ) -> Option<Box<dyn PluginProcessor>> {
        self.plugin_processors.insert(id.into(), processor)
    }

    pub(crate) fn take_clip(&mut self, id: &str) -> Option<Box<dyn AudioClipSource>> {
        self.clip_sources.remove(id)
    }

    pub(crate) fn clone_plugin(&self, id: &str) -> Option<Box<dyn PluginProcessor>> {
        self.plugin_processors.get(id).cloned()
    }
}
