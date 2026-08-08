use super::{
    Arc, ChannelKind, ChannelSpec, ClipSamples, ClipStoragePolicy, InputPeakBank, LiveMidiRoute,
    LiveMixerSendTap, LiveMixerSystemRole, LivePlugin, LivePluginAuxInput, LoadedClip,
    LowLatencyChannel, LowLatencyPlan, LowLatencyPlugin, MAX_INPUT_CHANNELS,
    MAX_PLUGIN_BLOCK_FRAMES, MeterAtomics, MeterBank, MetronomeScheduler, MixerGraph,
    NativeLatencyPolicy, NativeMidiClip, NativeMidiEventKind, NativeMixerChannel, NativeMixerClip,
    NativeMixerGraph, NativeMixerRuntime, NativeMixerSend, NativePluginInstance, Ordering,
    RenderMeter, RenderRuntime, Result, RouteTarget, ScheduledMidiEvent, ScheduledMidiEventKind,
    SendSpec, SendTap, SignalWidth, StereoDelayLine, TempoMap, TransportShared, audio_error,
    clip_storage_policy, decode_clip_audio, fs, invalid_config, parse_channel_kind,
    plan_low_latency, spawn_streaming_clip,
};
use crate::application_capture::ApplicationCaptureLogicalTarget;

#[path = "graph_build/clip_midi.rs"]
mod clip_midi;
#[path = "graph_build/plugin_graph.rs"]
mod plugin_graph;
#[path = "graph_build/routing.rs"]
mod routing;
#[path = "graph_build/validation.rs"]
mod validation;

use clip_midi::{build_midi_events, load_audio_clips};
use plugin_graph::{PluginGraphInput, build_plugin_graph};
use routing::{RoutingBuild, build_routing};
use validation::{InputRoutes, build_input_routes, validate_sample_rate};

pub(super) fn build_mixer_runtime(
    native: NativeMixerGraph,
    build_generation: u64,
    transport: Arc<TransportShared>,
    input_peaks: Arc<InputPeakBank>,
) -> Result<NativeMixerRuntime> {
    validate_sample_rate(native.sample_rate)?;
    transport
        .sample_rate
        .store(native.sample_rate, Ordering::Relaxed);
    let low_latency_plan = match &native.latency_policy {
        NativeLatencyPolicy::Normal => LowLatencyPlan {
            sensitive_channels: vec![false; native.channels.len()],
            ..LowLatencyPlan::default()
        },
        NativeLatencyPolicy::LowLatency {
            target_output_index,
            plugin_budget_samples,
        } => plan_low_latency(
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
        ),
    };
    let low_latency_bypassed = low_latency_plan
        .bypassed_plugin_instance_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let InputRoutes {
        meter: input_meter_routes,
        monitor: monitor_input_routes,
        source: source_input_routes,
    } = build_input_routes(&native.channels)?;
    let mut recording_channel_count = 0_usize;
    let recording_routes = native
        .channels
        .iter()
        .map(|channel| {
            if channel.kind != "audio"
                || !channel.record_armed
                || !matches!(
                    channel.input_source.as_deref(),
                    Some("hardware" | "application")
                )
            {
                return None;
            }
            let width = channel.input_channels.len().clamp(1, 2);
            let start = recording_channel_count;
            recording_channel_count = recording_channel_count.saturating_add(width);
            Some((start, width))
        })
        .collect::<Vec<_>>();
    if recording_channel_count > MAX_INPUT_CHANNELS {
        return Err(invalid_config("recording layout exceeds the channel limit"));
    }
    let external_source_monitoring = native
        .channels
        .iter()
        .map(|channel| {
            channel.input_monitoring
                && matches!(
                    channel.input_source.as_deref(),
                    Some("hardware" | "application")
                )
        })
        .collect::<Vec<_>>();
    let application_captures = native
        .channels
        .iter()
        .map(|channel| -> Result<Option<_>> {
            if channel.input_source.as_deref() != Some("application")
                || (!channel.input_monitoring && !channel.record_armed)
            {
                return Ok(None);
            }
            let Some(target) = channel.application_capture.as_ref() else {
                return Ok(None);
            };
            let logical = ApplicationCaptureLogicalTarget {
                platform: target.platform.clone(),
                bundle_identifier: target.bundle_identifier.clone(),
                executable_path: target.executable_path.clone(),
                executable_name: target.executable_name.clone(),
                include_process_tree: target.include_process_tree,
            };
            let capture = crate::application_capture::global_manager()
                .prepare_capture(&logical, native.sample_rate)
                .map_err(|error| invalid_config(error.to_string()))?;
            Ok(Some(capture))
        })
        .collect::<Result<Vec<_>>>()?;
    let RoutingBuild {
        channel_input_widths,
        live_midi_routes,
        channels,
        sends,
    } = build_routing(&native.channels, &native.sends)?;
    let tempo_map = TempoMap::new(
        native.tempo_events.clone(),
        native.time_signature_events.clone(),
    )
    .map_err(|error| invalid_config(error.to_string()))?;
    let project_end_frame = tempo_map
        .tick_to_frame(native.project_end_tick, native.sample_rate)
        .map_err(|error| invalid_config(error.to_string()))?;
    if project_end_frame == 0 {
        return Err(invalid_config("project end must be after tick zero"));
    }
    let metronome_channel_index = native
        .channels
        .iter()
        .position(|channel| channel.system_role == Some(LiveMixerSystemRole::Metronome));
    let meter_bank = Arc::new(MeterBank {
        channels: native
            .channels
            .iter()
            .map(|channel| MeterAtomics::new(channel.id.clone()))
            .collect(),
    });
    let (clips, content_end_frame) = load_audio_clips(native.clips, &channels, native.sample_rate)?;
    let plugin_build = build_plugin_graph(PluginGraphInput {
        sample_rate: native.sample_rate,
        native_plugins: native.plugins,
        native_sends: &native.sends,
        channels: &channels,
        sends,
        low_latency_plan: &low_latency_plan,
        low_latency_bypassed: &low_latency_bypassed,
        tempo_map: &tempo_map,
    })?;
    let midi_build = build_midi_events(
        native.midi_clips,
        &channels,
        &tempo_map,
        native.sample_rate,
        content_end_frame,
    )?;
    let tail_end_frame = (!plugin_build.has_infinite_tail).then_some(
        midi_build
            .content_end_frame
            .saturating_add(plugin_build.maximum_tail),
    );
    let metronome = MetronomeScheduler::new(
        metronome_channel_index,
        &tempo_map,
        native.sample_rate,
        transport.position_frames.load(Ordering::Relaxed),
    );
    Ok(NativeMixerRuntime {
        generation: native.generation,
        build_generation,
        peak_scratch: vec![
            RenderMeter {
                pre: [0.0; 2],
                post: [0.0; 2],
            };
            plugin_build.graph.channel_count()
        ],
        held_peaks: vec![[0.0, 0.0]; plugin_build.graph.channel_count()],
        held_until: vec![[0, 0]; plugin_build.graph.channel_count()],
        channel_source_block: vec![
            [0.0, 0.0];
            channels.len().saturating_mul(MAX_PLUGIN_BLOCK_FRAMES)
        ],
        channel_input_widths,
        plugins_by_channel: plugin_build.plugins_by_channel,
        midi_events: midi_build.events,
        midi_event_data: midi_build.event_data,
        midi_cursor: 0,
        active_notes: midi_build.active_notes,
        live_midi_routes,
        live_midi_events: Vec::with_capacity(
            heron_dsp_runtime::midi_input::MIDI_SHORT_QUEUE_CAPACITY,
        ),
        live_notes: vec![false; channels.len().saturating_mul(16 * 128)],
        external_sync_enabled: false,
        live_sysex_scratch: vec![0; heron_dsp_runtime::midi_input::MIDI_MAX_SYSEX_BYTES],
        metronome,
        count_in: None,
        tempo_map,
        graph: plugin_build.graph,
        clips,
        meter_bank,
        transport,
        sample_rate: native.sample_rate,
        content_end_frame: midi_build.content_end_frame,
        project_end_frame,
        tail_end_frame,
        has_infinite_tail: plugin_build.has_infinite_tail,
        input_peaks,
        input_meter_routes,
        monitor_input_routes,
        source_input_routes,
        recording_routes,
        recording_channel_count,
        external_source_monitoring,
        application_captures,
        input_peak_scratch: [0.0; MAX_INPUT_CHANNELS],
        meter_frame_clock: 0,
        audition: None,
    })
}
