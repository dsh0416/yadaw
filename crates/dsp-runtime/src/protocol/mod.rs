#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::panic_in_result_fn,
        clippy::unwrap_used
    )
)]

mod audio;
mod bounce;
mod commands;
mod events;
mod graph;
mod midi_input;
mod plugin;
mod recording;
mod responses;
mod rpc;
mod transport;
mod wire;

pub use audio::*;
pub use bounce::*;
pub use commands::*;
pub use events::*;
pub use graph::*;
pub use midi_input::*;
pub use plugin::*;
pub use recording::*;
pub use responses::*;
pub use rpc::*;
pub use transport::*;
pub use wire::*;

#[cfg(test)]
mod tests;
