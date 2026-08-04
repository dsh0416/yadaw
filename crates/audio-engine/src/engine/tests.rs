use std::{
    fs,
    sync::Arc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::device_streams::{
    BufferSelection, StreamErrorImpact, select_buffer_size, stream_error_impact,
};
use super::resampling::{AdaptiveResampler, SessionOutputConverter};
use super::{
    AtomicBool, AtomicU32, AtomicU64, AudioEngine, AudioEngineKey, BufferSize, ClipSamples,
    ClipStoragePolicy, EngineCommand, GRAPH_TEST_LOCK, InputPeakBank, LOOPBACK_PROBE, LivePlugin,
    LoadedClip, MAX_INPUT_CHANNELS, MAX_OUTPUT_CHANNELS, MAX_PLUGIN_BLOCK_FRAMES,
    MEMORY_DECODE_LIMIT_BYTES, METRONOME_ACCENT_NOTE, METRONOME_BEAT_NOTE, MeterAtomics, MeterBank,
    MetronomeScheduler, NativeLatencyPolicy, NativeMidiClip, NativeMidiEvent, NativeMidiEventKind,
    NativeMidiNote, NativeMixerChannel, NativeMixerGraph, NativeMixerParameterPreview,
    NativeMixerRuntime, NativeMixerSend, NativePluginAuxInputBus, NativePluginInstance,
    NativeRoundTripLatencyMeasurementRequest, OUTPUT_RESAMPLER_FRAMES, Ordering, PublishOutcome,
    RealtimeParameter, RealtimeParameterCommand, RoundTripInputDetector,
    RoundTripLatencyMeasurement, RoundTripOutputProbe, ScheduledMidiEvent, ScheduledMidiEventKind,
    SignalWidth, StereoDelayLine, StreamDirection, SupportedBufferSize, TRANSPORT_COUNTING_IN,
    TRANSPORT_PLAYING, TRANSPORT_RECORDING, TRANSPORT_STOPPED, TRANSPORT_WAITING, TransportAction,
    TransportShared, build_mixer_runtime, clip_storage_policy, compile_graph_build,
    compiled_graph_snapshot, frames_to_nanos, parse_channel_kind, resolve_stream_devices,
    spawn_streaming_clip,
};
use crate::recording::{
    NativeRecordingStartConfig, StereoFrame, write_deterministic_test_recording,
};
use heron_dsp_core::mixer::{ChannelKind, ChannelSpec, MixerGraph, RouteTarget};
use heron_dsp_render::{RenderMeter, RenderRuntime};
use heron_dsp_runtime::protocol::{
    CompiledGraphEdgeKind, CompiledGraphNodeKind, CompiledGraphPluginState,
    CompiledGraphSignalWidth, LiveMixerSendTap, LiveMixerSystemRole, PluginAudioMode,
};
use heron_dsp_runtime::tempo::{TempoEvent, TempoMap, TimeSignatureEvent};
use heron_vst3_host::HostProcessContext as ProcessContext;
use ringbuf::{
    HeapRb,
    traits::{Producer, Split},
};

fn assert_fixed(selection: BufferSelection, expected: u32, fell_back: bool) {
    assert!(matches!(selection.buffer_size, BufferSize::Fixed(value) if value == expected));
    assert_eq!(selection.expected_frames, expected);
    assert_eq!(selection.fell_back, fell_back);
}

fn rendered_session_frames(
    session_sample_rate: u32,
    output_sample_rate: u32,
    output_frames: usize,
) -> usize {
    let mut converter =
        SessionOutputConverter::new(session_sample_rate, output_sample_rate, 2).unwrap();
    let mut rendered = 0;
    let mut output = vec![[0.0; MAX_OUTPUT_CHANNELS]; MAX_PLUGIN_BLOCK_FRAMES];
    let mut offset = 0;
    while offset < output_frames {
        let block_frames = (output_frames - offset).min(MAX_PLUGIN_BLOCK_FRAMES);
        let (_, frames) = converter.render_block(&mut output[..block_frames], |session_output| {
            session_output.fill([0.0; MAX_OUTPUT_CHANNELS]);
            false
        });
        rendered += frames;
        offset += block_frames;
    }
    rendered
}

fn test_process_context() -> ProcessContext {
    ProcessContext {
        project_time_samples: 0,
        continuous_time_samples: 0,
        project_time_quarters: 0.0,
        bar_position_quarters: 0.0,
        tempo: 120.0,
        time_signature_numerator: 4,
        time_signature_denominator: 4,
        playing: false,
        recording: false,
    }
}

fn missing_effect(mode: PluginAudioMode, enabled: bool) -> LivePlugin {
    LivePlugin {
        instance_id: "missing-effect".to_owned(),
        processor: None,
        audio_mode: mode,
        enabled,
        is_instrument: false,
        latency_samples: 0,
        low_latency_bypassed: false,
        main_delay: StereoDelayLine::new(0),
        bypass_delay: StereoDelayLine::new(0),
        marker_index: 0,
        aux_inputs: Vec::new(),
    }
}

fn process_test_plugin(
    plugin: &mut LivePlugin,
    input: StereoFrame,
    width: &mut SignalWidth,
    context: &ProcessContext,
) -> StereoFrame {
    let mut frames = [input];
    plugin.process_block(&mut frames, width, context, &[]);
    frames[0]
}

fn transport_test_runtime(
    sample_rate: u32,
    content_end_frame: u64,
    position_frames: u64,
    state: u32,
) -> Box<NativeMixerRuntime> {
    let channels = vec![
        ChannelSpec {
            id: "audio-0".to_owned(),
            kind: ChannelKind::Audio,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: Some(RouteTarget::Output(2)),
            input_bus: None,
            hardware_output: None,
        },
        ChannelSpec {
            id: "master".to_owned(),
            kind: ChannelKind::Master,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: None,
            input_bus: None,
            hardware_output: None,
        },
        ChannelSpec {
            id: "output".to_owned(),
            kind: ChannelKind::Output,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: None,
            input_bus: None,
            hardware_output: Some([0, 1]),
        },
    ];
    let graph = MixerGraph::new(sample_rate, channels, Vec::new())
        .expect("transport test graph must be valid");
    let mut graph =
        RenderRuntime::from_mixer_graph(sample_rate, graph, TempoMap::default_120_bpm());
    graph.prepare_block_processing(MAX_PLUGIN_BLOCK_FRAMES);
    let length_frames = content_end_frame.max(1) as usize;
    Box::new(NativeMixerRuntime {
        generation: 1,
        build_generation: 1,
        peak_scratch: vec![
            RenderMeter {
                pre: [0.0; 2],
                post: [0.0; 2],
            };
            3
        ],
        held_peaks: vec![[0.0, 0.0]; 3],
        held_until: vec![[0, 0]; 3],
        channel_source_block: vec![[0.0, 0.0]; 3usize.saturating_mul(MAX_PLUGIN_BLOCK_FRAMES)],
        channel_input_widths: vec![SignalWidth::Stereo; 3],
        plugins_by_channel: vec![Vec::new(), Vec::new(), Vec::new()],
        midi_events: Vec::new(),
        midi_event_data: Vec::new(),
        midi_cursor: 0,
        active_notes: Vec::new(),
        live_midi_routes: vec![None; 3],
        live_midi_events: Vec::new(),
        live_notes: vec![false; 3 * 16 * 128],
        external_sync_enabled: false,
        live_sysex_scratch: vec![0; heron_dsp_runtime::midi_input::MIDI_MAX_SYSEX_BYTES],
        metronome: MetronomeScheduler::new(None, &TempoMap::default_120_bpm(), sample_rate, 0),
        count_in: None,
        tempo_map: TempoMap::default_120_bpm(),
        graph,
        clips: vec![LoadedClip {
            channel_index: 0,
            start_frame: 0,
            source_offset_frames: 0,
            length_frames,
            fade_in_frames: 0,
            fade_out_frames: 0,
            samples: ClipSamples::Memory(vec![[0.25, -0.25]; length_frames]),
        }],
        meter_bank: Arc::new(MeterBank {
            channels: (0..3)
                .map(|index| MeterAtomics::new(format!("channel-{index}")))
                .collect(),
        }),
        transport: Arc::new(TransportShared {
            state: Arc::new(AtomicU32::new(state)),
            position_frames: Arc::new(AtomicU64::new(position_frames)),
            position_ticks: Arc::new(AtomicU64::new(0)),
            sample_rate: AtomicU32::new(sample_rate),
            effective_bpm_bits: AtomicU64::new(f64::NAN.to_bits()),
            clock_source: AtomicU32::new(0),
            waiting_for: AtomicU32::new(0),
            loop_enabled: AtomicBool::new(false),
            loop_has_range: AtomicBool::new(false),
            loop_start_tick: AtomicU64::new(0),
            loop_end_tick: AtomicU64::new(0),
        }),
        sample_rate,
        content_end_frame,
        tail_end_frame: Some(content_end_frame),
        has_infinite_tail: false,
        input_peaks: Arc::new(InputPeakBank::new()),
        input_meter_routes: vec![None; 3],
        monitor_input_routes: vec![None; 3],
        input_peak_scratch: [0.0; MAX_INPUT_CHANNELS],
        meter_frame_clock: 0,
    })
}

fn test_transport(sample_rate: u32) -> Arc<TransportShared> {
    Arc::new(TransportShared {
        state: Arc::new(AtomicU32::new(TRANSPORT_STOPPED)),
        position_frames: Arc::new(AtomicU64::new(0)),
        position_ticks: Arc::new(AtomicU64::new(0)),
        sample_rate: AtomicU32::new(sample_rate),
        effective_bpm_bits: AtomicU64::new(f64::NAN.to_bits()),
        clock_source: AtomicU32::new(0),
        waiting_for: AtomicU32::new(0),
        loop_enabled: AtomicBool::new(false),
        loop_has_range: AtomicBool::new(false),
        loop_start_tick: AtomicU64::new(0),
        loop_end_tick: AtomicU64::new(0),
    })
}

fn mixer_channel(
    id: &str,
    kind: &str,
    output_index: Option<u32>,
    output_bus: Option<u32>,
    input_source: Option<&str>,
    input_channels: Vec<u32>,
    hardware_output_channels: Vec<u32>,
) -> NativeMixerChannel {
    NativeMixerChannel {
        id: id.to_owned(),
        name: id.to_owned(),
        color: "#000000".to_owned(),
        kind: kind.to_owned(),
        system_role: None,
        gain_db: 0.0,
        pan: 0.0,
        muted: false,
        soloed: false,
        output_index,
        output_bus,
        record_armed: false,
        input_monitoring: false,
        input_source: input_source.map(str::to_owned),
        input_channels,
        hardware_output_channels,
        midi_input_port_id: None,
        midi_input_channel: None,
    }
}

fn simple_native_graph() -> NativeMixerGraph {
    NativeMixerGraph {
        generation: 3,
        sample_rate: 48_000,
        latency_policy: NativeLatencyPolicy::Normal,
        channels: vec![
            mixer_channel(
                "audio-0",
                "audio",
                Some(2),
                None,
                Some("hardware"),
                vec![1, 2],
                Vec::new(),
            ),
            mixer_channel("master", "master", None, None, None, Vec::new(), Vec::new()),
            mixer_channel("output", "output", None, None, None, Vec::new(), vec![1, 2]),
        ],
        sends: Vec::new(),
        clips: Vec::new(),
        plugins: Vec::new(),
        midi_clips: Vec::new(),
        tempo_events: vec![TempoEvent {
            tick: 0,
            beats_per_minute: 120.0,
        }],
        time_signature_events: vec![TimeSignatureEvent {
            tick: 0,
            numerator: 4,
            denominator: 4,
        }],
    }
}

fn assert_build_err(
    result: std::result::Result<NativeMixerRuntime, crate::HostError>,
    needle: &str,
) {
    match result {
        Ok(_) => panic!("expected build_mixer_runtime to fail containing {needle:?}"),
        Err(error) => assert!(
            error.to_string().contains(needle),
            "error {:?} did not contain {needle:?}",
            error.to_string()
        ),
    }
}

#[path = "tests/device.rs"]
mod device;
#[path = "tests/graph.rs"]
mod graph;
#[path = "tests/publication.rs"]
mod publication;
#[path = "tests/render.rs"]
mod render;
#[path = "tests/transport_midi.rs"]
mod transport_midi;
