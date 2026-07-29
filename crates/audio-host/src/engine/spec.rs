pub struct NativeAudioEngineConfig {
    pub backend: String,
    pub input_device_id: String,
    pub output_device_id: String,
    pub buffer_size: u32,
    pub session_sample_rate: Option<u32>,
}

pub struct NativeAudioRuntimeSnapshot {
    pub state: String,
    pub requested_buffer_size: Option<u32>,
    pub sample_rate: Option<u32>,
    pub input_sample_rate: Option<u32>,
    pub output_sample_rate: Option<u32>,
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

pub struct NativeRoundTripLatencyMeasurementRequest {
    pub input_channel: u32,
    pub output_channel: u32,
}

pub struct NativeRoundTripLatencyMeasurementSnapshot {
    pub status: String,
    pub input_channel: Option<u32>,
    pub output_channel: Option<u32>,
    pub measured_round_trip_latency_ms: Option<f64>,
    pub failure: Option<String>,
}

#[derive(Clone)]
pub struct NativeMixerChannel {
    pub id: String,
    pub kind: String,
    pub system_role: Option<LiveMixerSystemRole>,
    pub gain_db: f64,
    pub pan: f64,
    pub muted: bool,
    pub soloed: bool,
    pub output_index: Option<u32>,
    pub output_bus: Option<u32>,
    pub record_armed: bool,
    pub input_monitoring: bool,
    pub input_source: Option<String>,
    pub input_channels: Vec<u32>,
    pub hardware_output_channels: Vec<u32>,
}

#[derive(Clone)]
pub struct NativeMixerSend {
    pub id: String,
    pub source_index: u32,
    pub target_output_index: Option<u32>,
    pub target_bus: Option<u32>,
    pub enabled: bool,
    pub tap: LiveMixerSendTap,
    pub level_db: f64,
}

#[derive(Clone)]
pub struct NativeMixerClip {
    pub id: String,
    pub channel_index: u32,
    pub start_frame: i64,
    pub source_offset_frames: i64,
    pub length_frames: i64,
    pub path: String,
}

#[derive(Clone)]
pub struct NativePluginInstance {
    pub instance_id: String,
    pub channel_index: u32,
    pub role: String,
    pub slot_order: u32,
    pub audio_mode: PluginAudioMode,
    pub enabled: bool,
    pub latency_samples: u32,
    pub tail_samples: Option<u32>,
    pub processor: Option<Vst3ProcessorHandle>,
}

#[derive(Clone)]
pub struct NativeMidiNote {
    pub start_tick: u64,
    pub duration_ticks: u64,
    pub channel: u8,
    pub key: u8,
    pub velocity: u8,
    pub release_velocity: u8,
}

#[derive(Clone)]
pub struct NativeMidiClip {
    pub id: String,
    pub channel_index: u32,
    pub start_tick: u64,
    pub source_offset_ticks: u64,
    pub length_ticks: u64,
    pub notes: Vec<NativeMidiNote>,
}

#[derive(Clone)]
pub struct NativeMixerGraph {
    pub generation: u64,
    pub sample_rate: u32,
    pub channels: Vec<NativeMixerChannel>,
    pub sends: Vec<NativeMixerSend>,
    pub clips: Vec<NativeMixerClip>,
    pub plugins: Vec<NativePluginInstance>,
    pub midi_clips: Vec<NativeMidiClip>,
    pub tempo_events: Vec<TempoEvent>,
    pub time_signature_events: Vec<TimeSignatureEvent>,
}

pub struct NativeMixerParameterPreview {
    pub target: String,
    pub id: String,
    pub parameter: String,
    pub value: f64,
}

pub struct NativeMixerChannelMeter {
    pub channel_id: String,
    pub pre_left: f64,
    pub pre_right: f64,
    pub post_left: f64,
    pub post_right: f64,
    pub held_left: f64,
    pub held_right: f64,
    pub clipped: bool,
}

pub struct NativeMixerSnapshot {
    pub meters: Vec<NativeMixerChannelMeter>,
}

pub struct NativeTransportSnapshot {
    pub state: String,
    pub position_frames: i64,
    pub sample_rate: u32,
}
