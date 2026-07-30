use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiInputPort {
    pub id: String,
    pub name: String,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MidiSyncPreferences {
    pub enabled: bool,
    pub source_port_id: Option<String>,
    pub source_port_name: Option<String>,
    pub input_offsets_ms: BTreeMap<String, f64>,
    #[serde(default)]
    pub control_port_ids: BTreeSet<String>,
    #[serde(default)]
    pub capture_all_controls: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MidiSyncRuntime {
    pub state: String,
    pub source_port_id: Option<String>,
    pub source_port_name: Option<String>,
    pub effective_bpm: Option<f64>,
    pub jitter_microseconds: f64,
    pub last_clock_age_ms: Option<f64>,
    pub dropped_events: u64,
    pub ignored_system_messages: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum MidiControlEventKind {
    Note { number: u8, value: u8 },
    ControlChange { number: u8, value: u8 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiControlEvent {
    pub generation: u64,
    pub timestamp_microseconds: u64,
    pub port_id: String,
    pub port_name: String,
    pub channel: u8,
    #[serde(flatten)]
    pub kind: MidiControlEventKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MidiInputSnapshot {
    pub ports: Vec<MidiInputPort>,
    pub sync: MidiSyncRuntime,
    pub control_events: Vec<MidiControlEvent>,
    pub captured_at: u64,
}
