use std::{
    error::Error,
    fmt,
    io::{self, Read, Write},
};

use ipc_channel::ipc::{IpcReceiver, IpcSender};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

/// The channels transferred exactly once when the helper connects.
#[derive(Serialize, Deserialize)]
pub struct HostBootstrap {
    pub requests: IpcReceiver<Vec<u8>>,
    pub responses: IpcSender<Vec<u8>>,
    pub events: IpcSender<Vec<u8>>,
}

/// Unsolicited helper notifications use a separate channel so editor and
/// runtime events cannot head-of-line block control responses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostEvent {
    Ready,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlRequest {
    pub version: u16,
    pub request_id: u64,
    pub command: ControlCommand,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlCommand {
    Ping,
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
    LoadGraph {
        revision: u64,
        graph: LiveMixerGraph,
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
        sample_rate: f64,
        #[serde(with = "serde_bytes")]
        component_state: Vec<u8>,
        #[serde(with = "serde_bytes")]
        controller_state: Vec<u8>,
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
    pub output_index: Option<u32>,
    pub record_armed: bool,
    pub input_channels: Vec<u32>,
    pub hardware_output_channels: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMixerSend {
    pub id: String,
    pub source_index: u32,
    pub target_index: u32,
    pub enabled: bool,
    pub tap: String,
    pub level_db: f64,
    pub pan: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveMixerClip {
    pub id: String,
    pub channel_index: u32,
    pub start_frame: i64,
    pub source_offset_frames: i64,
    pub length_frames: i64,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LivePluginInstance {
    pub instance_id: String,
    pub channel_index: u32,
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
    pub channel_index: u32,
    pub start_tick: u64,
    pub source_offset_ticks: u64,
    pub length_ticks: u64,
    pub notes: Vec<LiveMidiNote>,
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
    #[serde(with = "serde_bytes")]
    pub peaks: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParameterGesture {
    Begin,
    Perform,
    End,
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
    pub version: u16,
    pub request_id: u64,
    pub result: ControlResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlResult {
    Pong,
    Heartbeat {
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
        latency_samples: u32,
        tail_samples: Option<u32>,
    },
    PluginParameters {
        parameters: Vec<PluginParameter>,
    },
    PluginState {
        #[serde(with = "serde_bytes")]
        component_state: Vec<u8>,
        #[serde(with = "serde_bytes")]
        controller_state: Vec<u8>,
    },
    PluginEditor {
        editor_kind: String,
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
    VersionMismatch(u16),
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
            Self::VersionMismatch(version) => {
                write!(formatter, "unsupported helper protocol version {version}")
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

pub fn validate_version(version: u16) -> Result<(), ProtocolError> {
    if version == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(ProtocolError::VersionMismatch(version))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messagepack_frame_round_trips() {
        let request = ControlRequest {
            version: PROTOCOL_VERSION,
            request_id: 42,
            command: ControlCommand::LoadGraph {
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
        };
        let mut bytes = Vec::new();
        write_message(&mut bytes, &request).unwrap();
        assert_eq!(
            read_message::<ControlRequest>(&mut bytes.as_slice()).unwrap(),
            request
        );
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
}
