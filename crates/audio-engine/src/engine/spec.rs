use super::{
    LiveMixerSendTap, LiveMixerSystemRole, LowLatencyChannel, LowLatencyPlan, LowLatencyPlugin,
    PluginAudioMode, TempoEvent, TimeSignatureEvent, Vst3ProcessorHandle, plan_low_latency,
};

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
    pub name: String,
    pub color: String,
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
    pub application_capture: Option<NativeApplicationCaptureTarget>,
    pub hardware_output_channels: Vec<u32>,
    pub midi_input_port_id: Option<String>,
    pub midi_input_channel: Option<u8>,
}

#[derive(Clone)]
pub struct NativeApplicationCaptureTarget {
    pub platform: String,
    pub executable_path: String,
    pub executable_name: String,
    pub include_process_tree: bool,
}

#[derive(Clone)]
pub struct NativePluginAuxInputBus {
    pub input_bus_index: u32,
    pub name: String,
    pub channels: u8,
    pub source_index: Option<u32>,
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
    pub fade_in_frames: i64,
    pub fade_out_frames: i64,
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
    pub aux_input_buses: Vec<NativePluginAuxInputBus>,
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
pub enum NativeMidiEventKind {
    ControlChange { controller: u8, value: u8 },
    PitchBend { value: u16 },
    ProgramChange { program: u8 },
    ChannelPressure { pressure: u8 },
    PolyPressure { key: u8, pressure: u8 },
    SysEx { data: Vec<u8> },
}

#[derive(Clone)]
pub struct NativeMidiEvent {
    pub tick: u64,
    pub channel: u8,
    pub kind: NativeMidiEventKind,
}

#[derive(Clone)]
pub struct NativeMidiClip {
    pub id: String,
    pub channel_index: u32,
    pub start_tick: u64,
    pub source_offset_ticks: u64,
    pub length_ticks: u64,
    pub notes: Vec<NativeMidiNote>,
    pub events: Vec<NativeMidiEvent>,
}

#[derive(Clone)]
pub struct NativeMixerGraph {
    pub generation: u64,
    pub sample_rate: u32,
    pub project_end_tick: u64,
    pub latency_policy: NativeLatencyPolicy,
    pub channels: Vec<NativeMixerChannel>,
    pub sends: Vec<NativeMixerSend>,
    pub clips: Vec<NativeMixerClip>,
    pub plugins: Vec<NativePluginInstance>,
    pub midi_clips: Vec<NativeMidiClip>,
    pub tempo_events: Vec<TempoEvent>,
    pub time_signature_events: Vec<TimeSignatureEvent>,
}

#[derive(Clone, Default)]
pub enum NativeLatencyPolicy {
    #[default]
    Normal,
    LowLatency {
        target_output_index: u32,
        plugin_budget_samples: u32,
    },
}

pub(super) fn plan_native_low_latency(native: &NativeMixerGraph) -> LowLatencyPlan {
    let NativeLatencyPolicy::LowLatency {
        target_output_index,
        plugin_budget_samples,
    } = &native.latency_policy
    else {
        return LowLatencyPlan {
            sensitive_channels: vec![false; native.channels.len()],
            ..LowLatencyPlan::default()
        };
    };
    plan_low_latency(
        &native
            .channels
            .iter()
            .map(|channel| LowLatencyChannel {
                output: channel.output_index.map(|index| index as usize),
                input_buses: if channel.input_source.as_deref() == Some("bus") {
                    channel.input_channels.clone()
                } else {
                    Vec::new()
                },
                output_bus: channel.output_bus,
                monitored: channel.input_monitoring
                    && (channel.kind == "instrument"
                        || channel.input_source.as_deref() == Some("hardware")
                        || channel.input_source.as_deref() == Some("application")),
            })
            .collect::<Vec<_>>(),
        &native
            .plugins
            .iter()
            .map(|plugin| LowLatencyPlugin {
                instance_id: plugin.instance_id.clone(),
                channel: plugin.channel_index as usize,
                slot_order: plugin.slot_order,
                latency_samples: plugin.latency_samples,
                instrument: plugin.role == "instrument",
            })
            .collect::<Vec<_>>(),
        *target_output_index as usize,
        *plugin_budget_samples,
    )
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
    pub position_ticks: i64,
    pub sample_rate: u32,
    pub effective_bpm: Option<f64>,
    pub clock_source: String,
    pub waiting_for: Option<String>,
    pub loop_enabled: bool,
    pub loop_start_tick: Option<i64>,
    pub loop_end_tick: Option<i64>,
}
