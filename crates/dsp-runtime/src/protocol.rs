use std::{
    error::Error,
    fmt,
    io::{self, Read, Write},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const NATIVE_BUILD_FINGERPRINT: &str = env!("YADAW_NATIVE_BUILD_FINGERPRINT");
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub const INLINE_BLOB_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SharedBlobRef {
    pub session_epoch: u64,
    pub region_id: u32,
    pub region_generation: u64,
    pub slot: u16,
    pub allocation_generation: u64,
    pub offset: u64,
    pub length: u64,
    pub lease_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "storage", rename_all = "kebab-case")]
pub enum BinaryPayload {
    Inline {
        #[serde(with = "serde_bytes")]
        bytes: Vec<u8>,
    },
    Shared {
        reference: SharedBlobRef,
    },
    Attachment {
        index: u16,
        offset: u64,
        length: u64,
    },
}

impl BinaryPayload {
    #[must_use]
    pub fn inline(bytes: Vec<u8>) -> Self {
        Self::Inline { bytes }
    }

    #[must_use]
    pub fn as_inline(&self) -> Option<&[u8]> {
        match self {
            Self::Inline { bytes } => Some(bytes),
            Self::Shared { .. } | Self::Attachment { .. } => None,
        }
    }
}

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
    },
    GraphPublished {
        revision: u64,
    },
    RuntimeFailure {
        message: String,
        plugin_instance_id: Option<String>,
        phase: Option<String>,
    },
    PluginRuntime {
        instance_id: String,
        kind: String,
        value: String,
    },
    PluginEditorPreferenceChanged {
        class_id: String,
        preference: PluginEditorPreference,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginEditorMode {
    Native,
    Parameters,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginEditorPreference {
    pub mode: PluginEditorMode,
    pub zoom_percent: u16,
}

impl Default for PluginEditorPreference {
    fn default() -> Self {
        Self {
            mode: PluginEditorMode::Native,
            zoom_percent: 100,
        }
    }
}

impl PluginEditorPreference {
    #[must_use]
    pub const fn is_valid(self) -> bool {
        self.zoom_percent >= 50 && self.zoom_percent <= 400
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlRequest {
    pub request_id: u64,
    pub command: ControlCommand,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriorityRequest {
    pub request_id: u64,
    pub command: PriorityCommand,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PriorityCommand {
    Heartbeat,
    Shutdown,
    ParameterWake,
    ParameterBoundary { command: ParameterCommand },
    ReleaseLeases { lease_ids: Vec<u64> },
    TelemetryPageReady { epoch: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriorityResponse {
    pub request_id: u64,
    pub result: PriorityResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PriorityResult {
    Heartbeat {
        ipc_generation: u64,
        tokio_generation: u64,
        winit_generation: u64,
        callback_generation: u64,
        transport_state: String,
        egress_active: u64,
        egress_queue_depth: u64,
        egress_queue_high_water: u64,
        egress_batches: u64,
        blocking_jobs: u64,
        arena_regions: u64,
        arena_capacity_bytes: u64,
        arena_used_bytes: u64,
        arena_high_water_bytes: u64,
        arena_offers: u64,
        arena_busy: u64,
        arena_quarantined_regions: u64,
        arena_copied_bytes: u64,
    },
    Accepted,
    Busy,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlCommand {
    Ping,
    BenchmarkEcho {
        payload: BinaryPayload,
    },
    Shutdown,
    ListAudioBackends,
    ListAudioDevices {
        backend: String,
    },
    StartAudioEngine {
        config: AudioEngineConfig,
    },
    StopAudioEngine,
    AudioEngineSnapshot,
    UpdateGraph {
        update: GraphUpdate,
    },
    PreviewMixerParameter {
        preview: MixerParameterPreview,
    },
    MixerSnapshot,
    ClearMeterClips,
    Transport {
        command: TransportControl,
    },
    TransportSnapshot,
    StartRecording {
        config: RecordingStartConfig,
    },
    StopRecording,
    RecordingWaveform {
        start_frame: i64,
        end_frame: i64,
        max_buckets: u32,
    },
    LoadPlugin {
        instance_id: String,
        module_path: String,
        class_id: String,
        plugin_kind: String,
        sample_rate: f64,
        component_state: BinaryPayload,
        controller_state: BinaryPayload,
    },
    UnloadPlugin {
        instance_id: String,
    },
    PluginParameters {
        instance_id: String,
    },
    SetPluginParameter {
        instance_id: String,
        parameter_id: u32,
        normalized: f64,
        gesture: ParameterGesture,
    },
    SavePluginState {
        instance_id: String,
    },
    OpenPluginEditor {
        instance_id: String,
        preference: PluginEditorPreference,
    },
    ClosePluginEditor {
        instance_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioEngineConfig {
    pub backend: String,
    pub input_device_id: String,
    pub output_device_id: String,
    pub buffer_size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioBackend {
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub default_sample_rate: Option<u32>,
    pub min_buffer_size: Option<u32>,
    pub max_buffer_size: Option<u32>,
    pub channel_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioDeviceList {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioRuntime {
    pub state: String,
    pub requested_buffer_size: Option<u32>,
    pub sample_rate: Option<u32>,
    pub input_sample_rate: Option<u32>,
    pub input_buffer_size: Option<u32>,
    pub output_buffer_size: Option<u32>,
    pub ring_buffer_capacity_frames: Option<u32>,
    pub ring_buffer_fill_frames: Option<u32>,
    pub input_latency_ms: Option<f64>,
    pub output_latency_ms: Option<f64>,
    pub ring_buffer_latency_ms: Option<f64>,
    pub engine_latency_ms: Option<f64>,
    pub estimated_round_trip_latency_ms: Option<f64>,
    pub xruns: u32,
    pub clock_sync: String,
    pub buffer_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMixerChannel {
    pub id: String,
    pub kind: String,
    pub gain_db: f64,
    pub pan: f64,
    pub muted: bool,
    pub soloed: bool,
    pub output_channel_id: Option<String>,
    pub record_armed: bool,
    pub input_channels: Vec<u32>,
    pub hardware_output_channels: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LiveMixerSendTap {
    Pre,
    Post,
    PostPan,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMixerSend {
    pub id: String,
    pub source_channel_id: String,
    pub target_channel_id: String,
    pub enabled: bool,
    pub tap: LiveMixerSendTap,
    pub level_db: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMixerClip {
    pub id: String,
    pub channel_id: String,
    pub start_frame: i64,
    pub source_offset_frames: i64,
    pub length_frames: i64,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LivePluginInstance {
    pub instance_id: String,
    pub channel_id: String,
    pub role: String,
    pub slot_order: u32,
    pub enabled: bool,
    pub latency_samples: u32,
    pub tail_samples: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMidiNote {
    pub start_tick: u64,
    pub duration_ticks: u64,
    pub channel: u8,
    pub key: u8,
    pub velocity: u8,
    pub release_velocity: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMidiClip {
    pub id: String,
    pub channel_id: String,
    pub start_tick: u64,
    pub source_offset_ticks: u64,
    pub length_ticks: u64,
    pub notes: MidiNoteBatch,
    pub events: MidiEventBatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "storage", rename_all = "kebab-case")]
pub enum MidiNoteBatch {
    Inline { notes: Vec<LiveMidiNote> },
    Shared { reference: SharedBlobRef },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMidiEvent {
    pub tick: u64,
    pub channel: Option<u8>,
    pub kind: String,
    pub data: BinaryPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "storage", rename_all = "kebab-case")]
pub enum MidiEventBatch {
    Inline { events: Vec<LiveMidiEvent> },
    Shared { reference: SharedBlobRef },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveTempoEvent {
    pub tick: u64,
    pub beats_per_minute: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveTimeSignatureEvent {
    pub tick: u64,
    pub numerator: u8,
    pub denominator: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMixerGraph {
    pub sample_rate: u32,
    pub channels: Vec<LiveMixerChannel>,
    pub sends: Vec<LiveMixerSend>,
    pub clips: Vec<LiveMixerClip>,
    pub plugins: Vec<LivePluginInstance>,
    pub midi_clips: Vec<LiveMidiClip>,
    pub tempo_events: Vec<LiveTempoEvent>,
    pub time_signature_events: Vec<LiveTimeSignatureEvent>,
}

impl LiveMixerGraph {
    pub fn apply_ops(&mut self, ops: Vec<GraphOp>) {
        for op in ops {
            match op {
                GraphOp::UpsertChannel { value } => {
                    upsert_by(&mut self.channels, value, |item| &item.id);
                }
                GraphOp::RemoveChannel { id } => {
                    self.channels.retain(|item| item.id != id);
                }
                GraphOp::UpsertSend { value } => {
                    upsert_by(&mut self.sends, value, |item| &item.id);
                }
                GraphOp::RemoveSend { id } => {
                    self.sends.retain(|item| item.id != id);
                }
                GraphOp::UpsertClip { value } => {
                    upsert_by(&mut self.clips, value, |item| &item.id);
                }
                GraphOp::RemoveClip { id } => {
                    self.clips.retain(|item| item.id != id);
                }
                GraphOp::UpsertPlugin { value } => {
                    upsert_by(&mut self.plugins, value, |item| &item.instance_id);
                }
                GraphOp::RemovePlugin { id } => {
                    self.plugins.retain(|item| item.instance_id != id);
                }
                GraphOp::UpsertMidiClip { value } => {
                    upsert_by(&mut self.midi_clips, value, |item| &item.id);
                }
                GraphOp::RemoveMidiClip { id } => {
                    self.midi_clips.retain(|item| item.id != id);
                }
                GraphOp::ReplaceTempoMap {
                    tempo_events,
                    time_signature_events,
                } => {
                    self.tempo_events = tempo_events;
                    self.time_signature_events = time_signature_events;
                }
            }
        }
    }
}

fn upsert_by<T, F>(values: &mut Vec<T>, value: T, id: F)
where
    F: Fn(&T) -> &str,
{
    if let Some(index) = values
        .iter()
        .position(|candidate| id(candidate) == id(&value))
    {
        values[index] = value;
    } else {
        values.push(value);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum GraphUpdate {
    Replace {
        revision: u64,
        graph: LiveMixerGraph,
    },
    Patch {
        base_revision: u64,
        revision: u64,
        ops: Vec<GraphOp>,
    },
}

impl GraphUpdate {
    #[must_use]
    pub fn revision(&self) -> u64 {
        match self {
            Self::Replace { revision, .. } | Self::Patch { revision, .. } => *revision,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum GraphOp {
    UpsertChannel {
        value: LiveMixerChannel,
    },
    RemoveChannel {
        id: String,
    },
    UpsertSend {
        value: LiveMixerSend,
    },
    RemoveSend {
        id: String,
    },
    UpsertClip {
        value: LiveMixerClip,
    },
    RemoveClip {
        id: String,
    },
    UpsertPlugin {
        value: LivePluginInstance,
    },
    RemovePlugin {
        id: String,
    },
    UpsertMidiClip {
        value: LiveMidiClip,
    },
    RemoveMidiClip {
        id: String,
    },
    ReplaceTempoMap {
        tempo_events: Vec<LiveTempoEvent>,
        time_signature_events: Vec<LiveTimeSignatureEvent>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MixerParameterPreview {
    pub target: String,
    pub id: String,
    pub parameter: String,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MixerChannelMeter {
    pub channel_id: String,
    pub pre_left: f64,
    pub pre_right: f64,
    pub post_left: f64,
    pub post_right: f64,
    pub held_left: f64,
    pub held_right: f64,
    pub clipped: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransportControl {
    pub kind: String,
    pub position_frames: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportState {
    pub state: String,
    pub position_frames: i64,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingStartConfig {
    pub path: String,
    pub asset_id: String,
    pub originator: String,
    pub origination_date: String,
    pub origination_time: String,
    pub time_reference: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingResult {
    pub path: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub dropout_frames: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingWaveform {
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: i64,
    pub start_frame: i64,
    pub end_frame: i64,
    pub frames_per_bucket: u32,
    pub bucket_count: u32,
    pub peaks: BinaryPayload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParameterGesture {
    Begin,
    Perform,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u32)]
#[serde(rename_all = "kebab-case")]
pub enum ParameterTargetKind {
    Plugin = 1,
    MixerChannel = 2,
    MixerSend = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ParameterCommand {
    pub session_epoch: u64,
    pub sequence: u64,
    pub target_kind: ParameterTargetKind,
    pub runtime_handle: u32,
    pub parameter_id: u32,
    pub normalized: f64,
    pub gesture: ParameterGesture,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginParameter {
    pub id: u32,
    pub title: String,
    pub units: String,
    pub step_count: i32,
    pub default_normalized: f64,
    pub normalized: f64,
    pub flags: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlResponse {
    pub request_id: u64,
    pub result: ControlResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlResult {
    Pong,
    BenchmarkEcho {
        payload: BinaryPayload,
    },
    Heartbeat {
        ipc_generation: u64,
        tokio_generation: u64,
        winit_generation: u64,
        callback_generation: u64,
        transport_state: String,
    },
    Accepted,
    AudioBackends {
        backends: Vec<AudioBackend>,
    },
    AudioDevices {
        devices: AudioDeviceList,
    },
    AudioRuntime {
        runtime: AudioRuntime,
    },
    MixerSnapshot {
        meters: Vec<MixerChannelMeter>,
    },
    TransportSnapshot {
        transport: TransportState,
    },
    RecordingStopped {
        recording: RecordingResult,
    },
    RecordingWaveform {
        waveform: RecordingWaveform,
    },
    PluginLoaded {
        runtime_handle: u32,
        latency_samples: u32,
        tail_samples: Option<u32>,
    },
    PluginParameters {
        parameters: Vec<PluginParameter>,
    },
    PluginState {
        component_state: BinaryPayload,
        controller_state: BinaryPayload,
    },
    GraphAccepted {
        revision: u64,
    },
    RevisionMismatch {
        current_revision: u64,
    },
    Busy,
    PluginEditor {
        active_mode: PluginEditorMode,
        open: bool,
    },
    Error {
        message: String,
    },
}

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    Encode(rmp_serde::encode::Error),
    Decode(rmp_serde::decode::Error),
    MessageTooLarge(usize),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "helper protocol I/O failed: {error}"),
            Self::Encode(error) => write!(formatter, "helper message encoding failed: {error}"),
            Self::Decode(error) => write!(formatter, "helper message decoding failed: {error}"),
            Self::MessageTooLarge(size) => {
                write!(formatter, "helper message exceeds 64 MiB: {size}")
            }
        }
    }
}

impl Error for ProtocolError {}

impl From<io::Error> for ProtocolError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

pub fn write_message<T: Serialize>(
    writer: &mut impl Write,
    value: &T,
) -> Result<(), ProtocolError> {
    let payload = rmp_serde::to_vec_named(value).map_err(ProtocolError::Encode)?;
    if payload.len() > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::MessageTooLarge(payload.len()));
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

pub fn read_message<T: DeserializeOwned>(reader: &mut impl Read) -> Result<T, ProtocolError> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::MessageTooLarge(length));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload)?;
    rmp_serde::from_slice(&payload).map_err(ProtocolError::Decode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messagepack_frame_round_trips() {
        let request = ControlRequest {
            request_id: 42,
            command: ControlCommand::UpdateGraph {
                update: GraphUpdate::Replace {
                    revision: 7,
                    graph: LiveMixerGraph {
                        sample_rate: 48_000,
                        channels: vec![],
                        sends: vec![],
                        clips: vec![],
                        plugins: vec![],
                        midi_clips: vec![],
                        tempo_events: vec![LiveTempoEvent {
                            tick: 0,
                            beats_per_minute: 120.0,
                        }],
                        time_signature_events: vec![LiveTimeSignatureEvent {
                            tick: 0,
                            numerator: 4,
                            denominator: 4,
                        }],
                    },
                },
            },
        };
        let mut bytes = Vec::new();
        write_message(&mut bytes, &request).unwrap();
        assert_eq!(
            read_message::<ControlRequest>(&mut bytes.as_slice()).unwrap(),
            request
        );
    }

    #[test]
    fn native_build_fingerprint_is_a_stable_hex_identifier() {
        assert_eq!(NATIVE_BUILD_FINGERPRINT.len(), 16);
        assert!(
            NATIVE_BUILD_FINGERPRINT
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        );
    }

    #[test]
    fn mixer_send_taps_use_stable_kebab_case_wire_values() {
        for (tap, wire_value) in [
            (LiveMixerSendTap::Pre, "pre"),
            (LiveMixerSendTap::Post, "post"),
            (LiveMixerSendTap::PostPan, "post-pan"),
        ] {
            let bytes = rmp_serde::to_vec(&tap).unwrap();
            assert_eq!(rmp_serde::from_slice::<String>(&bytes).unwrap(), wire_value);
            assert_eq!(
                rmp_serde::from_slice::<LiveMixerSendTap>(&bytes).unwrap(),
                tap
            );
        }

        let unknown = rmp_serde::to_vec(&"unknown").unwrap();
        assert!(rmp_serde::from_slice::<LiveMixerSendTap>(&unknown).is_err());
    }

    #[test]
    fn rejects_oversized_frame_before_allocating() {
        let mut bytes = ((MAX_MESSAGE_BYTES as u32) + 1).to_be_bytes().to_vec();
        bytes.extend_from_slice(&[0; 4]);
        assert!(matches!(
            read_message::<ControlRequest>(&mut bytes.as_slice()),
            Err(ProtocolError::MessageTooLarge(_))
        ));
    }

    #[test]
    fn stable_id_patch_matches_the_equivalent_full_graph() {
        let output = LiveMixerChannel {
            id: "output".into(),
            kind: "output".into(),
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output_channel_id: None,
            record_armed: false,
            input_channels: vec![],
            hardware_output_channels: vec![0, 1],
        };
        let mut patched = LiveMixerGraph {
            sample_rate: 48_000,
            channels: vec![output.clone()],
            sends: vec![],
            clips: vec![],
            plugins: vec![],
            midi_clips: vec![],
            tempo_events: vec![LiveTempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![LiveTimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        };
        let audio = LiveMixerChannel {
            id: "audio-1".into(),
            kind: "audio".into(),
            gain_db: -3.0,
            pan: 0.25,
            muted: false,
            soloed: false,
            output_channel_id: Some("output".into()),
            record_armed: false,
            input_channels: vec![],
            hardware_output_channels: vec![],
        };
        patched.apply_ops(vec![
            GraphOp::UpsertChannel {
                value: audio.clone(),
            },
            GraphOp::ReplaceTempoMap {
                tempo_events: vec![
                    LiveTempoEvent {
                        tick: 0,
                        beats_per_minute: 120.0,
                    },
                    LiveTempoEvent {
                        tick: 960,
                        beats_per_minute: 90.0,
                    },
                ],
                time_signature_events: vec![LiveTimeSignatureEvent {
                    tick: 0,
                    numerator: 4,
                    denominator: 4,
                }],
            },
        ]);
        let mut full = patched.clone();
        full.channels = vec![output, audio];
        assert_eq!(patched, full);
    }
}
