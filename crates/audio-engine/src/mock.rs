//! A mock cpal backend built on cpal's custom-host API.
//!
//! The mock backend presents a fully functional audio host that never touches
//! real hardware. Selecting it is the equivalent of disabling CoreAudio in Logic
//! Pro: the engine, transport, mixer graph, and plugins all run, but capture is
//! synthesised and playback is discarded. That makes it useful for three
//! situations:
//!
//! - Debugging the engine without a physical device holding the driver open.
//! - Deterministic automated tests and headless CI where no driver exists.
//! - Running the application on machines with no usable audio hardware.
//!
//! Because it is a real [`cpal`] host rather than a bespoke worker loop, the
//! engine drives it through exactly the same device enumeration, stream
//! building, resampling, metering, and recording code paths as WASAPI, ASIO,
//! CoreAudio, or ALSA.
//!
//! Playback is looped back into capture, so features that depend on hearing the
//! engine's own output — most notably round-trip latency measurement — behave as
//! they would with a physical loopback cable. Devices are exposed under cpal's
//! `custom` host, so their identifiers carry a `custom:` prefix, for example
//! `custom:mock-duplex`.

use std::{
    fmt,
    hash::{Hash, Hasher},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::{
    BufferSize, ChannelCount, Data, DeviceDescription, DeviceDescriptionBuilder, DeviceDirection,
    DeviceId, DeviceType, Error, ErrorKind, FrameCount, Host, HostId, InputCallbackInfo,
    InputStreamTimestamp, InterfaceType, OutputCallbackInfo, OutputStreamTimestamp, SampleFormat,
    SampleRate, StreamConfig, StreamInstant, SupportedBufferSize, SupportedStreamConfig,
    SupportedStreamConfigRange,
    platform::CustomHost,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};

/// The backend identifier accepted by [`crate::device`] and the audio engine.
pub const BACKEND_ID: &str = "mock";

/// The human-readable backend name shown in the audio device settings.
pub const BACKEND_LABEL: &str = "Mock";

/// The only sample rate the mock devices run at.
const SAMPLE_RATE: SampleRate = 48_000;

/// The channel count of every mock device, for both capture and playback.
const CHANNELS: ChannelCount = 2;

const MIN_BUFFER_FRAMES: FrameCount = 32;
const MAX_BUFFER_FRAMES: FrameCount = 2_048;
const DEFAULT_BUFFER_FRAMES: FrameCount = 256;

/// How far playback may run ahead of capture before the loopback drops frames.
///
/// The bound keeps measured loopback latency close to one block even when the
/// capture worker is descheduled for several blocks at a time.
const LOOPBACK_SLACK_BLOCKS: usize = 4;

const LOOPBACK_CAPACITY_FRAMES: usize = MAX_BUFFER_FRAMES as usize * (LOOPBACK_SLACK_BLOCKS + 1);

/// The sample format the mock devices exchange with the engine.
const SAMPLE_FORMAT: SampleFormat = SampleFormat::F32;

type LoopbackFrame = [f32; CHANNELS as usize];

/// Whether `backend` selects the mock backend.
///
/// Matching is case-insensitive to stay consistent with how cpal host
/// identifiers are compared elsewhere.
pub fn is_mock_backend(backend: &str) -> bool {
    backend.eq_ignore_ascii_case(BACKEND_ID)
}

/// Builds a cpal [`Host`] backed by the mock devices.
///
/// Each call produces an independent host with its own loopback, so streams
/// built from one host never observe audio from another.
pub fn host() -> Host {
    Host::from(CustomHost::from_host(MockHost::new()))
}

include!("mock/device.rs");
include!("mock/stream.rs");
include!("mock/tests.rs");
