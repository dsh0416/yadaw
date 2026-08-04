use serde::{Deserialize, Serialize};

use super::{AraCallbackEvent, MidiInputSnapshot, PluginEditorPreference, RpcError};

/// Unsolicited helper notifications use a separate channel so editor and
/// runtime events cannot head-of-line block control responses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostEvent {
    Ready,
    ReleaseLeases {
        lease_ids: Vec<u64>,
    },
    TelemetryPageOffer {
        epoch: u64,
        capacity: u32,
        descriptor_version: u32,
        object_id: [u8; 16],
        byte_len: u64,
        generation: u64,
    },
    TelemetryPageActive {
        epoch: u64,
        generation: u64,
    },
    GraphPublished {
        revision: u64,
    },
    RuntimeFailure {
        error: RpcError,
        plugin_instance_id: Option<String>,
        phase: Option<String>,
    },
    PluginRuntime {
        instance_id: String,
        kind: String,
        value: String,
    },
    AraCallback {
        instance_id: String,
        sequence: u64,
        event: AraCallbackEvent,
    },
    PluginEditorPreferenceChanged {
        class_id: String,
        preference: PluginEditorPreference,
    },
    /// Native editor windows closed without a matching ClosePluginEditor RPC
    /// (user close, GPU device loss/OOM). Electron reconciles open-editor state.
    PluginEditorClosed {
        instance_id: String,
    },
    /// A route intent emitted by host-owned editor chrome. Electron main is the
    /// only process allowed to turn it into a persisted project command.
    PluginSidechainRouteRequested {
        request_id: u64,
        instance_id: String,
        input_bus_index: u32,
        source_channel_id: Option<String>,
    },
    MidiInputSnapshot {
        snapshot: MidiInputSnapshot,
    },
}
