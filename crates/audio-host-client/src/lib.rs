#![deny(unsafe_code)]
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
    collections::{HashMap, VecDeque},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use heron_dsp_runtime::protocol::{
    ControlCommand, ControlRequest, HostEvent, MAX_MESSAGE_BYTES, ParameterCommand,
    ParameterGesture, ParameterTargetKind, PriorityCommand, PriorityRequest, PriorityResponse,
};
use heron_ipc_transport::{
    ArenaReceiver, HostBootstrap, LeaseRegistry, MAX_OUTSTANDING_LEASE_BYTES,
    MAX_OUTSTANDING_LEASES, MappingCommand, MappingEvent, ParameterEnqueue, ParameterProducer,
    SharedMemoryDescriptor, TelemetryReader, TelemetrySnapshot, WirePacket, create_parameter_ring,
    create_telemetry_page, decode_body, decode_response_to_attachments, encode_body,
    encode_priority, encode_request_with_attachments,
};
use ipc_channel::{
    TryRecvError,
    ipc::{self, IpcOneShotServer, IpcReceiver, IpcSender},
};
use napi::{
    Env, Error, JsDeferred, Result, Status,
    bindgen_prelude::{Buffer, Object},
};
use napi_derive::napi;

const OUTBOUND_CAPACITY: usize = 256;
const ROUTER_POLL: Duration = Duration::from_millis(50);
const MAX_LOGICAL_REQUEST_BYTES: usize = MAX_MESSAGE_BYTES * 2;

include!("client/state.rs");
include!("client/napi_facade.rs");
include!("client/request_routing.rs");
include!("client/routing_helpers.rs");
include!("client/egress.rs");
include!("client/response_router.rs");
include!("client/priority_router.rs");
include!("client/event_router.rs");
include!("client/lease_release.rs");
include!("client/tests.rs");
