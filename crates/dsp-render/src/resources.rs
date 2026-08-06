use std::collections::HashMap;

use heron_audio_plugin::AudioPluginProcessorHandle;

/// Random-access decoded audio. Implementations must keep `sample` free of
/// blocking, I/O, locks, allocation, and deallocation.
pub trait AudioClipSource: Send + Sync {
    fn channels(&self) -> u32;
    fn frame_count(&self) -> u64;
    fn sample(&self, frame: u64, channel: u32) -> f32;
}

#[derive(Default)]
pub struct RenderResources {
    clip_sources: HashMap<String, Box<dyn AudioClipSource>>,
    plugin_processors: HashMap<String, AudioPluginProcessorHandle>,
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
        processor: AudioPluginProcessorHandle,
    ) -> Option<AudioPluginProcessorHandle> {
        self.plugin_processors.insert(id.into(), processor)
    }

    pub(crate) fn take_clip(&mut self, id: &str) -> Option<Box<dyn AudioClipSource>> {
        self.clip_sources.remove(id)
    }

    pub(crate) fn clone_plugin(&self, id: &str) -> Option<AudioPluginProcessorHandle> {
        self.plugin_processors.get(id).cloned()
    }
}
