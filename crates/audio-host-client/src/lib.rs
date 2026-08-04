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

mod client;

pub use client::{
    AudioHostIpcClient, IpcResponse, ParameterEnqueueRequest, ParameterEnqueueResult,
};
