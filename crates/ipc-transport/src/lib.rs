//! Cross-process transport primitives for the audio helper.
//!
//! MessagePack remains the logical protocol. Fixed process-shared mappings
//! carry telemetry, parameter commands, and large immutable payloads, while
//! `ipc-channel` carries only control messages and mapping descriptors.
#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::panic_in_result_fn,
        clippy::unwrap_used
    )
)]

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    mem::{align_of, size_of},
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use heron_dsp_runtime::protocol::{
    BinaryPayload, ControlCommand, ControlRequest, ControlResponse, ControlResult, GraphOp,
    GraphUpdate, HostEvent, INLINE_BLOB_LIMIT, LiveMidiEvent, LiveMidiNote, LiveMixerGraph,
    MAX_MESSAGE_BYTES, MidiEventBatch, MidiNoteBatch, ParameterCommand, ParameterGesture,
    ParameterTargetKind, SharedBlobRef,
};
pub use heron_shared_memory::{SharedMemory, SharedMemoryDescriptor, SharedMemoryError};
use ipc_channel::ipc::{IpcReceiver, IpcSender};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use zerocopy::{
    FromBytes, Immutable, IntoBytes, KnownLayout, Unaligned,
    byteorder::little_endian::{U16, U32, U64},
};

mod arena;
mod atomic_page;
mod codec;
mod error;
mod graph_payload;
mod midi_wire;
mod parameter_ring;
mod telemetry;

pub use arena::*;
use atomic_page::*;
pub use codec::*;
pub use error::*;
pub use graph_payload::*;
pub use midi_wire::*;
pub use parameter_ring::*;
pub use telemetry::*;

pub const MAX_OUTSTANDING_LEASES: usize = 256;
pub const MAX_OUTSTANDING_LEASE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_ARENA_REGIONS: usize = 32;
pub const MAX_REGION_SLOTS: usize = 64;
pub const LEASE_TIMEOUT: Duration = Duration::from_secs(30);
pub const PARAMETER_RING_CAPACITY: u32 = 4096;
pub const PARAMETER_BOUNDARY_RESERVE: u64 = 64;
pub const INITIAL_TELEMETRY_CAPACITY: u32 = 64;

#[cfg(target_endian = "big")]
compile_error!("Heron shared-page ABI currently supports little-endian targets only");

#[cfg(test)]
mod tests;
