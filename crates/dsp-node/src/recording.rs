use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
};
#[cfg(any(test, feature = "bench-internals"))]
use std::{
    io::BufWriter,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[cfg(any(test, feature = "bench-internals"))]
use bwavfile::AudioFrameWriter;
use bwavfile::{Bext, WAVE_TAG_FLOAT, WaveFmt, WaveReader, WaveWriter};
use napi::{Error, Result, Status, Task, bindgen_prelude::Buffer};
use napi_derive::napi;
#[cfg(any(test, feature = "bench-internals"))]
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};
use rubato::{Fft, FixedSync, Resampler, audioadapter_buffers::direct::InterleavedSlice};
use sha2::{Digest, Sha256};

#[cfg(any(test, feature = "bench-internals"))]
#[allow(dead_code)]
pub type StereoFrame = [f32; 2];
#[cfg(any(test, feature = "bench-internals"))]
pub const MAX_INPUT_CHANNELS: usize = 32;
#[cfg(any(test, feature = "bench-internals"))]
pub type InputFrame = [f32; MAX_INPUT_CHANNELS];

#[cfg(any(test, feature = "bench-internals"))]
const RECORDING_RING_SECONDS: usize = 8;
#[cfg(any(test, feature = "bench-internals"))]
const WRITER_BLOCK_FRAMES: usize = 2_048;
const WAVEFORM_BASE_FRAMES: usize = 64;
const WAVEFORM_LEVEL_FACTOR: usize = 4;

mod finalize;
mod realtime_tap;
mod repair;
#[cfg(test)]
mod tests;
mod waveform;
mod waveform_analysis;
mod writer;
mod writer_format;

pub(crate) use waveform_analysis::analyze_waveform_path;
pub(crate) use writer_format::{broadcast_metadata, float_format, recording_error};

#[cfg(any(test, feature = "bench-internals"))]
pub use realtime_tap::RecordingTap;
#[cfg(feature = "bench-internals")]
pub use repair::bench_support;
pub use repair::{repair_recording_header, write_deterministic_test_recording};
#[cfg(any(test, feature = "bench-internals"))]
pub use waveform::NativeWaveformSnapshot;
pub use waveform::{
    NativeAnalyzedWaveform, NativeFinalizeRecordingConfig, NativeFinalizedRecording,
    NativeRecordingResult, NativeRecordingStartConfig, NativeWaveformLevel,
};
pub use waveform_analysis::{analyze_waveform, finalize_recording};
#[cfg(any(test, feature = "bench-internals"))]
pub use writer::RecorderController;
