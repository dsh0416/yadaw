mod egress;
mod event_router;
mod lease_release;
mod napi_facade;
mod priority_router;
mod request_routing;
mod response_router;
mod routing_helpers;
mod state;

pub use napi_facade::AudioHostIpcClient;
pub use state::{IpcResponse, ParameterEnqueueRequest, ParameterEnqueueResult};

pub(super) const OUTBOUND_CAPACITY: usize = 256;
pub(super) const ROUTER_POLL: std::time::Duration = std::time::Duration::from_millis(50);
pub(super) const MAX_LOGICAL_REQUEST_BYTES: usize =
    heron_dsp_runtime::protocol::MAX_MESSAGE_BYTES * 2;

#[cfg(test)]
mod tests;
