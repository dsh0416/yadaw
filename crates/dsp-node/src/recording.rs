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

include!("recording/waveform.rs");
include!("recording/writer_format.rs");
include!("recording/realtime_tap.rs");
include!("recording/writer.rs");
include!("recording/finalize.rs");
include!("recording/waveform_analysis.rs");
include!("recording/repair.rs");
include!("recording/tests.rs");
