//! Format-neutral real-time audio plug-in interfaces.
//!
//! Format implementations own their ABI and control-thread objects. The audio
//! engine only receives cloneable processor endpoints defined by this crate.

use std::{collections::HashMap, fmt, hash::Hash};

/// Plug-in binary format understood by the host registry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PluginFormat {
    Vst3,
    Clap,
}

impl PluginFormat {
    /// Stable lower-case value used by wire and persistence adapters.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Vst3 => "vst3",
            Self::Clap => "clap",
        }
    }
}

impl fmt::Display for PluginFormat {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Persistable identity of one plug-in type in one artifact.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PluginLocator {
    pub format: PluginFormat,
    pub artifact_path: String,
    pub native_id: String,
}

impl PluginLocator {
    /// Key for preferences shared by relocations of the same plug-in type.
    #[must_use]
    pub fn type_key(&self) -> String {
        format!("{}:{}", self.format, self.native_id)
    }
}

/// Stable, persistable key of an audio port.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct AudioPortKey(pub String);

/// Stable, persistable key of a plug-in parameter.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ParameterKey(pub String);

/// One opaque format-defined state chunk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginStateChunk {
    pub key: String,
    pub bytes: Vec<u8>,
}

/// Versioned state container shared by every plug-in format.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginStateEnvelope {
    pub version: u32,
    pub chunks: Vec<PluginStateChunk>,
}

impl Default for PluginStateEnvelope {
    fn default() -> Self {
        Self {
            version: 1,
            chunks: Vec::new(),
        }
    }
}

/// A dense audio-port token resolved while a plug-in instance is prepared.
///
/// Tokens are instance-local and must never be persisted. Persisted routing
/// uses the stable string port key exposed by the public contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct AudioPortToken(u32);

impl AudioPortToken {
    /// Creates an instance-local token.
    #[must_use]
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    /// Returns the dense numeric representation used by real-time adapters.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// A dense parameter token resolved while a plug-in instance is prepared.
///
/// Tokens are generation-scoped and are safe to place in the bounded direct
/// parameter queue. Stable parameter keys remain outside the audio callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct ParameterToken(u32);

impl ParameterToken {
    /// Creates a generation-scoped token.
    #[must_use]
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    /// Returns the dense numeric representation used by real-time adapters.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Per-instance translation between stable format-native parameter identities
/// and dense generation-scoped real-time tokens.
#[derive(Clone, Debug)]
pub struct ParameterTokenMap<NativeId> {
    token_to_native: HashMap<u32, NativeId>,
    native_to_token: HashMap<NativeId, u32>,
}

impl<NativeId> ParameterTokenMap<NativeId>
where
    NativeId: Copy + Eq + Hash + Ord,
{
    /// Assigns deterministic dense tokens starting at one. Returns `None` only
    /// when the native identity count exceeds the `u32` token space.
    pub fn from_native_ids(ids: impl IntoIterator<Item = NativeId>) -> Option<Self> {
        let mut ids = ids.into_iter().collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        let mut token_to_native = HashMap::with_capacity(ids.len());
        let mut native_to_token = HashMap::with_capacity(ids.len());
        for (index, native_id) in ids.into_iter().enumerate() {
            let token = u32::try_from(index).ok()?.checked_add(1)?;
            token_to_native.insert(token, native_id);
            native_to_token.insert(native_id, token);
        }
        Some(Self {
            token_to_native,
            native_to_token,
        })
    }

    #[must_use]
    pub fn native_id(&self, token: u32) -> Option<NativeId> {
        self.token_to_native.get(&token).copied()
    }

    #[must_use]
    pub fn token(&self, native_id: NativeId) -> Option<u32> {
        self.native_to_token.get(&native_id).copied()
    }
}

/// Transport and musical timing information at the first frame of a block.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProcessContext {
    pub project_time_samples: i64,
    pub continuous_time_samples: i64,
    pub steady_time_samples: i64,
    pub project_time_quarters: f64,
    pub bar_position_quarters: f64,
    pub tempo: f64,
    pub time_signature_numerator: i32,
    pub time_signature_denominator: i32,
    pub playing: bool,
    pub recording: bool,
    pub loop_active: bool,
    pub loop_start_quarters: f64,
    pub loop_end_quarters: f64,
}

/// Read-only sidechain blocks made available for one processing call.
pub trait SidechainSource {
    fn frames(&self, port: AudioPortToken) -> Option<&[[f32; 2]]>;
}

/// Object-safe, allocation-free-after-construction plug-in processor endpoint.
///
/// Implementations are transferred between graph generations, but a concrete
/// endpoint is called by only one audio thread at a time.
pub trait AudioPluginProcessor: Send {
    fn clone_box(&self) -> Box<dyn AudioPluginProcessor>;

    fn process_block(
        &mut self,
        frames: &mut [[f32; 2]],
        sidechains: &dyn SidechainSource,
        context: &ProcessContext,
    ) -> bool;

    /// Balances format-specific audio-thread lifecycle before a graph endpoint
    /// is returned to the control thread. Must not allocate or block.
    fn retire(&mut self) {}

    fn note_on(
        &mut self,
        _offset: usize,
        _channel: u8,
        _key: u8,
        _velocity: u8,
        _note_id: i32,
    ) -> bool {
        false
    }

    fn note_off(
        &mut self,
        _offset: usize,
        _channel: u8,
        _key: u8,
        _velocity: u8,
        _note_id: i32,
    ) -> bool {
        false
    }

    fn poly_pressure(&mut self, _offset: usize, _channel: u8, _key: u8, _pressure: u8) -> bool {
        false
    }

    fn control_change(
        &mut self,
        _offset: usize,
        _channel: u8,
        _controller: u8,
        _value: u8,
    ) -> bool {
        false
    }

    fn pitch_bend(&mut self, _offset: usize, _channel: u8, _value: u16) -> bool {
        false
    }

    fn channel_pressure(&mut self, _offset: usize, _channel: u8, _pressure: u8) -> bool {
        false
    }

    fn program_change(&mut self, _offset: usize, _channel: u8, _program: u8) -> bool {
        false
    }

    fn sysex(&mut self, _offset: usize, _bytes: &[u8]) -> bool {
        false
    }

    /// Queues one plain-value parameter event for the next process block.
    fn parameter(&mut self, _offset: usize, _token: ParameterToken, _value: f64) -> bool {
        false
    }
}

/// Cloneable type-erased processor handle stored by render graphs.
pub struct AudioPluginProcessorHandle {
    inner: Box<dyn AudioPluginProcessor>,
    duplicate_mono_output: bool,
}

impl AudioPluginProcessorHandle {
    /// Erases one format-specific real-time endpoint.
    #[must_use]
    pub fn new(processor: impl AudioPluginProcessor + 'static) -> Self {
        Self {
            inner: Box::new(processor),
            duplicate_mono_output: false,
        }
    }

    /// Duplicates the processed mono left channel into the right channel.
    #[must_use]
    pub fn with_mono_output_duplication(mut self) -> Self {
        self.duplicate_mono_output = true;
        self
    }

    pub fn process_block(
        &mut self,
        frames: &mut [[f32; 2]],
        sidechains: &dyn SidechainSource,
        context: &ProcessContext,
    ) -> bool {
        let processed = self.inner.process_block(frames, sidechains, context);
        if processed && self.duplicate_mono_output {
            for frame in frames {
                frame[1] = frame[0];
            }
        }
        processed
    }

    pub fn retire(&mut self) {
        self.inner.retire();
    }

    pub fn note_on(
        &mut self,
        offset: usize,
        channel: u8,
        key: u8,
        velocity: u8,
        note_id: i32,
    ) -> bool {
        self.inner.note_on(offset, channel, key, velocity, note_id)
    }

    pub fn note_off(
        &mut self,
        offset: usize,
        channel: u8,
        key: u8,
        velocity: u8,
        note_id: i32,
    ) -> bool {
        self.inner.note_off(offset, channel, key, velocity, note_id)
    }

    pub fn poly_pressure(&mut self, offset: usize, channel: u8, key: u8, pressure: u8) -> bool {
        self.inner.poly_pressure(offset, channel, key, pressure)
    }

    pub fn control_change(
        &mut self,
        offset: usize,
        channel: u8,
        controller: u8,
        value: u8,
    ) -> bool {
        self.inner
            .control_change(offset, channel, controller, value)
    }

    pub fn pitch_bend(&mut self, offset: usize, channel: u8, value: u16) -> bool {
        self.inner.pitch_bend(offset, channel, value)
    }

    pub fn channel_pressure(&mut self, offset: usize, channel: u8, pressure: u8) -> bool {
        self.inner.channel_pressure(offset, channel, pressure)
    }

    pub fn program_change(&mut self, offset: usize, channel: u8, program: u8) -> bool {
        self.inner.program_change(offset, channel, program)
    }

    pub fn sysex(&mut self, offset: usize, bytes: &[u8]) -> bool {
        self.inner.sysex(offset, bytes)
    }

    pub fn parameter(&mut self, offset: usize, token: ParameterToken, value: f64) -> bool {
        self.inner.parameter(offset, token, value)
    }
}

impl Clone for AudioPluginProcessorHandle {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone_box(),
            duplicate_mono_output: self.duplicate_mono_output,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AudioPluginProcessor, AudioPluginProcessorHandle, AudioPortToken, ParameterTokenMap,
        ProcessContext, SidechainSource,
    };

    #[derive(Clone)]
    struct MonoProcessor;

    impl AudioPluginProcessor for MonoProcessor {
        fn clone_box(&self) -> Box<dyn AudioPluginProcessor> {
            Box::new(self.clone())
        }

        fn process_block(
            &mut self,
            frames: &mut [[f32; 2]],
            _sidechains: &dyn SidechainSource,
            _context: &ProcessContext,
        ) -> bool {
            for frame in frames {
                frame[0] *= 2.0;
                frame[1] = 0.0;
            }
            true
        }
    }

    struct NoSidechains;

    impl SidechainSource for NoSidechains {
        fn frames(&self, _port: AudioPortToken) -> Option<&[[f32; 2]]> {
            None
        }
    }

    fn process_context() -> ProcessContext {
        ProcessContext {
            project_time_samples: 0,
            continuous_time_samples: 0,
            steady_time_samples: 0,
            project_time_quarters: 0.0,
            bar_position_quarters: 0.0,
            tempo: 120.0,
            time_signature_numerator: 4,
            time_signature_denominator: 4,
            playing: false,
            recording: false,
            loop_active: false,
            loop_start_quarters: 0.0,
            loop_end_quarters: 0.0,
        }
    }

    #[test]
    fn parameter_tokens_are_dense_deterministic_and_instance_local() {
        let tokens = ParameterTokenMap::from_native_ids([90_u64, 7, 90, 42]).unwrap();
        assert_eq!(tokens.token(7), Some(1));
        assert_eq!(tokens.token(42), Some(2));
        assert_eq!(tokens.token(90), Some(3));
        assert_eq!(tokens.native_id(2), Some(42));
        assert_eq!(tokens.native_id(0), None);
    }

    #[test]
    fn mono_output_duplication_runs_after_successful_native_processing() {
        let mut processor =
            AudioPluginProcessorHandle::new(MonoProcessor).with_mono_output_duplication();
        let mut frames = [[0.25, 9.0], [-0.5, 9.0]];

        assert!(processor.process_block(&mut frames, &NoSidechains, &process_context()));
        assert_eq!(frames, [[0.5, 0.5], [-1.0, -1.0]]);
    }
}
