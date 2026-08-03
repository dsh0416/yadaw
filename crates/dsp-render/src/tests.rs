use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::{Arc, Mutex},
};

use crate::{
    AudioClipSource, HardwareOutputFrame, PluginProcessContext, PluginProcessor, RenderBuildError,
    RenderChannelKind, RenderChannelSpec, RenderClipSpec, RenderGraphSpec, RenderMeter,
    RenderMidiNote, RenderMidiSpec, RenderPluginSpec, RenderResources, RenderRoute, RenderRuntime,
    RenderSendSpec, RenderSendTap, RenderTransport, TempoEvent, TimeSignatureEvent,
};
use yadaw_dsp_core::mixer::{ChannelKind, ChannelSpec, MixerGraph, RouteTarget};

struct TrackingAllocator;

// Counting is thread-local so the allocation assertions stay valid while the
// rest of the suite runs in parallel on other test threads.
thread_local! {
    static TRACK_ALLOCATIONS: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    static DEALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

// SAFETY: Every operation is delegated unchanged to the process system
// allocator. The counters are diagnostic side effects only.
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK_ALLOCATIONS.try_with(Cell::get).unwrap_or(false) {
            ALLOCATIONS.with(|count| count.set(count.get() + 1));
        }
        // SAFETY: Delegating the caller-provided layout to the system allocator.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if TRACK_ALLOCATIONS.try_with(Cell::get).unwrap_or(false) {
            DEALLOCATIONS.with(|count| count.set(count.get() + 1));
        }
        // SAFETY: `pointer` and `layout` originate from the matching allocator.
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: TrackingAllocator = TrackingAllocator;

struct ConstantClip;

impl AudioClipSource for ConstantClip {
    fn channels(&self) -> u32 {
        2
    }

    fn frame_count(&self) -> u64 {
        128
    }

    fn sample(&self, _frame: u64, channel: u32) -> f32 {
        if channel == 0 { 0.5 } else { -0.25 }
    }
}

#[derive(Clone)]
struct GainPlugin(f32);

impl PluginProcessor for GainPlugin {
    fn clone_box(&self) -> Box<dyn PluginProcessor> {
        Box::new(self.clone())
    }

    fn process_frame(&mut self, mut frame: [f32; 2], _context: PluginProcessContext) -> [f32; 2] {
        frame[0] *= self.0;
        frame[1] *= self.0;
        frame
    }

    fn note_on(&mut self, _channel: u8, _key: u8, _velocity: u8) {}

    fn note_off(&mut self, _channel: u8, _key: u8, _velocity: u8) {}
}

/// Records every note and parameter call so MIDI dispatch can be asserted.
#[derive(Clone, Default)]
struct RecordingPlugin {
    notes: Arc<Mutex<Vec<NoteEvent>>>,
    parameters: Arc<Mutex<Vec<(u32, f64)>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoteEvent {
    On(u8, u8, u8),
    Off(u8, u8, u8),
}

impl RecordingPlugin {
    fn take_notes(&self) -> Vec<NoteEvent> {
        std::mem::take(&mut *self.notes.lock().expect("note log should not be poisoned"))
    }
}

impl PluginProcessor for RecordingPlugin {
    fn clone_box(&self) -> Box<dyn PluginProcessor> {
        Box::new(self.clone())
    }

    fn process_frame(&mut self, frame: [f32; 2], _context: PluginProcessContext) -> [f32; 2] {
        frame
    }

    fn note_on(&mut self, channel: u8, key: u8, velocity: u8) {
        self.notes
            .lock()
            .expect("note log should not be poisoned")
            .push(NoteEvent::On(channel, key, velocity));
    }

    fn note_off(&mut self, channel: u8, key: u8, velocity: u8) {
        self.notes
            .lock()
            .expect("note log should not be poisoned")
            .push(NoteEvent::Off(channel, key, velocity));
    }

    fn set_parameter(&mut self, parameter_id: u32, normalized: f64) {
        self.parameters
            .lock()
            .expect("parameter log should not be poisoned")
            .push((parameter_id, normalized));
    }
}

/// Captures the transport context the graph hands to each processor.
#[derive(Clone, Default)]
struct ContextProbe(Arc<Mutex<Vec<PluginProcessContext>>>);

impl PluginProcessor for ContextProbe {
    fn clone_box(&self) -> Box<dyn PluginProcessor> {
        Box::new(self.clone())
    }

    fn process_frame(&mut self, frame: [f32; 2], context: PluginProcessContext) -> [f32; 2] {
        self.0
            .lock()
            .expect("context log should not be poisoned")
            .push(context);
        frame
    }

    fn note_on(&mut self, _channel: u8, _key: u8, _velocity: u8) {}

    fn note_off(&mut self, _channel: u8, _key: u8, _velocity: u8) {}
}

fn channel(id: &str, kind: RenderChannelKind) -> RenderChannelSpec {
    RenderChannelSpec {
        id: id.into(),
        kind,
        gain_db: 0.0,
        pan: 0.0,
        muted: false,
        soloed: false,
        output: None,
        input_bus: None,
        hardware_input: None,
        hardware_output: None,
    }
}

fn spec() -> RenderGraphSpec {
    RenderGraphSpec {
        sample_rate: 48_000,
        channels: vec![
            RenderChannelSpec {
                output: Some(RenderRoute::Channel("output".into())),
                ..channel("audio", RenderChannelKind::Audio)
            },
            channel("master", RenderChannelKind::Master),
            RenderChannelSpec {
                hardware_output: Some([0, 1]),
                ..channel("output", RenderChannelKind::Output)
            },
        ],
        sends: vec![],
        clips: vec![RenderClipSpec {
            id: "clip".into(),
            source_id: "clip-source".into(),
            channel_id: "audio".into(),
            start_frame: 0,
            source_offset_frames: 0,
            length_frames: 128,
        }],
        plugins: vec![RenderPluginSpec {
            id: "plugin".into(),
            processor_id: "gain".into(),
            channel_id: "audio".into(),
            slot_order: 0,
            enabled: true,
        }],
        midi: vec![],
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

fn resources() -> RenderResources {
    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(ConstantClip));
    resources.insert_plugin("gain", Box::new(GainPlugin(0.5)));
    resources
}

fn build(spec: RenderGraphSpec) -> Result<RenderRuntime, RenderBuildError> {
    RenderRuntime::build(spec, resources())
}

/// `RenderRuntime` is not `Debug`, so failures are compared through the error.
fn build_error(spec: RenderGraphSpec) -> RenderBuildError {
    match build(spec) {
        Ok(_) => panic!("expected the render graph build to fail"),
        Err(error) => error,
    }
}

fn is_silent(output: HardwareOutputFrame) -> bool {
    output.iter().all(|sample| *sample == 0.0)
}

fn runtime() -> RenderRuntime {
    build(spec()).expect("deterministic render graph should build")
}

#[test]
fn deterministic_runtime_baseline_and_render_are_allocation_free() {
    let mut runtime = runtime();
    runtime.set_transport(RenderTransport::Playing);
    let output = runtime.render_frame(&[]);
    assert!((output[0] - 0.25).abs() < 1.0e-6);
    assert!((output[1] + 0.125).abs() < 1.0e-6);
    assert_eq!(runtime.diagnostic_snapshot().sample_position, 1);
    assert_eq!(runtime.diagnostic_snapshot().plugin_count, 1);

    let mut meters = [RenderMeter {
        pre: [0.0; 2],
        post: [0.0; 2],
    }; 3];
    runtime.write_meters(&mut meters);
    assert!(meters[0].pre[0] >= 0.25);
    assert!(meters[0].post[0] >= 0.25);

    ALLOCATIONS.with(|count| count.set(0));
    DEALLOCATIONS.with(|count| count.set(0));
    TRACK_ALLOCATIONS.with(|tracking| tracking.set(true));
    for _ in 0..32 {
        let _ = runtime.render_frame(&[]);
    }
    TRACK_ALLOCATIONS.with(|tracking| tracking.set(false));
    assert_eq!(ALLOCATIONS.with(Cell::get), 0);
    assert_eq!(DEALLOCATIONS.with(Cell::get), 0);
}

#[test]
fn build_reports_the_channel_a_route_could_not_resolve() {
    let mut spec = spec();
    spec.channels[0].output = Some(RenderRoute::Channel("nowhere".into()));

    assert_eq!(
        build_error(spec),
        RenderBuildError::MissingChannel("nowhere".into())
    );
}

#[test]
fn build_reports_a_send_that_names_an_unknown_source_or_target() {
    let mut with_bad_source = spec();
    with_bad_source.sends = vec![RenderSendSpec {
        id: "send".into(),
        source_channel_id: "nowhere".into(),
        target: RenderRoute::Channel("output".into()),
        enabled: true,
        tap: RenderSendTap::Post,
        level_db: 0.0,
    }];
    assert_eq!(
        build_error(with_bad_source),
        RenderBuildError::MissingChannel("nowhere".into())
    );

    let mut with_bad_target = spec();
    with_bad_target.sends = vec![RenderSendSpec {
        id: "send".into(),
        source_channel_id: "audio".into(),
        target: RenderRoute::Channel("nowhere".into()),
        enabled: true,
        tap: RenderSendTap::Pre,
        level_db: 0.0,
    }];
    assert_eq!(
        build_error(with_bad_target),
        RenderBuildError::MissingChannel("nowhere".into())
    );
}

#[test]
fn build_reports_a_clip_on_an_unknown_channel_or_without_decoded_audio() {
    let mut unknown_channel = spec();
    unknown_channel.clips[0].channel_id = "nowhere".into();
    assert_eq!(
        build_error(unknown_channel),
        RenderBuildError::MissingChannel("nowhere".into())
    );

    let mut unknown_source = spec();
    unknown_source.clips[0].source_id = "not-decoded".into();
    assert_eq!(
        build_error(unknown_source),
        RenderBuildError::MissingClipSource("not-decoded".into())
    );
}

#[test]
fn build_reports_a_plugin_without_an_instantiated_processor() {
    let mut spec = spec();
    spec.plugins[0].processor_id = "not-instantiated".into();

    assert_eq!(
        build_error(spec),
        RenderBuildError::MissingPluginProcessor("not-instantiated".into())
    );
}

#[test]
fn build_reports_midi_addressed_to_an_unknown_plugin() {
    let mut spec = spec();
    spec.midi = vec![RenderMidiSpec {
        plugin_id: "nowhere".into(),
        notes: vec![],
    }];

    assert_eq!(
        build_error(spec),
        RenderBuildError::MissingPlugin("nowhere".into())
    );
}

#[test]
fn build_reports_an_invalid_tempo_map() {
    let mut spec = spec();
    spec.tempo_events = vec![TempoEvent {
        tick: 480,
        beats_per_minute: 120.0,
    }];

    assert!(matches!(build_error(spec), RenderBuildError::Tempo(_)));
}

#[test]
fn build_errors_describe_themselves() {
    let messages = [
        RenderBuildError::MissingChannel("audio".into()).to_string(),
        RenderBuildError::MissingClipSource("clip".into()).to_string(),
        RenderBuildError::MissingPluginProcessor("gain".into()).to_string(),
        RenderBuildError::MissingPlugin("plugin".into()).to_string(),
    ];

    assert_eq!(messages[0], "render channel 'audio' was not found");
    assert_eq!(messages[1], "clip source 'clip' was not provided");
    assert_eq!(messages[2], "plugin processor 'gain' was not provided");
    assert_eq!(messages[3], "render plugin 'plugin' was not found");

    let mut invalid = spec();
    invalid.tempo_events = vec![];
    let tempo = build_error(invalid);
    assert!(tempo.to_string().starts_with("could not build tempo map"));
}

#[test]
fn disabled_plugins_are_left_out_of_the_render_chain() {
    let mut spec = spec();
    spec.plugins[0].enabled = false;

    let runtime = build(spec).expect("graph should build without the bypassed plugin");

    assert_eq!(runtime.diagnostic_snapshot().plugin_count, 0);
}

#[test]
fn plugins_run_in_slot_order_rather_than_declaration_order() {
    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(ConstantClip));
    resources.insert_plugin("boost", Box::new(GainPlugin(4.0)));
    resources.insert_plugin("mute", Box::new(GainPlugin(0.0)));
    let mut spec = spec();
    spec.plugins = vec![
        RenderPluginSpec {
            id: "second".into(),
            processor_id: "boost".into(),
            channel_id: "audio".into(),
            slot_order: 1,
            enabled: true,
        },
        RenderPluginSpec {
            id: "first".into(),
            processor_id: "mute".into(),
            channel_id: "audio".into(),
            slot_order: 0,
            enabled: true,
        },
    ];

    let mut runtime =
        RenderRuntime::build(spec, resources).expect("graph with two inserts should build");
    let output = runtime.render_frame(&[]);

    // The slot-0 processor silences the signal, so the boost has nothing left.
    assert!(is_silent(output));
}

#[test]
fn clips_contribute_only_inside_their_own_window() {
    let mut spec = spec();
    spec.clips[0].start_frame = 2;
    spec.clips[0].length_frames = 1;
    spec.plugins.clear();
    let mut runtime = build(spec).expect("graph should build");
    runtime.set_transport(RenderTransport::Playing);

    let before = runtime.render_frame(&[]);
    let also_before = runtime.render_frame(&[]);
    let inside = runtime.render_frame(&[]);
    let after = runtime.render_frame(&[]);

    assert!(is_silent(before));
    assert!(is_silent(also_before));
    assert!((inside[0] - 0.5).abs() < 1.0e-6);
    assert!(is_silent(after));
}

#[test]
fn clips_stop_contributing_past_the_end_of_their_source() {
    let mut spec = spec();
    spec.clips[0].source_offset_frames = 127;
    spec.clips[0].length_frames = 4;
    spec.plugins.clear();
    let mut runtime = build(spec).expect("graph should build");
    runtime.set_transport(RenderTransport::Playing);

    let last = runtime.render_frame(&[]);
    let past_end = runtime.render_frame(&[]);

    assert!((last[0] - 0.5).abs() < 1.0e-6);
    assert!(is_silent(past_end));
}

#[test]
fn a_mono_clip_is_duplicated_across_both_output_channels() {
    struct MonoClip;

    impl AudioClipSource for MonoClip {
        fn channels(&self) -> u32 {
            1
        }

        fn frame_count(&self) -> u64 {
            8
        }

        fn sample(&self, _frame: u64, _channel: u32) -> f32 {
            0.5
        }
    }

    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(MonoClip));
    let mut spec = spec();
    spec.plugins.clear();

    let mut runtime = RenderRuntime::build(spec, resources).expect("mono graph should build");
    let output = runtime.render_frame(&[]);

    assert!((output[0] - 0.5).abs() < 1.0e-6);
    assert!((output[1] - 0.5).abs() < 1.0e-6);
}

#[test]
fn hardware_inputs_are_read_from_the_declared_channel_pair() {
    let mut spec = spec();
    spec.channels[0].hardware_input = Some([1, 3]);
    spec.clips.clear();
    spec.plugins.clear();

    let mut runtime = build(spec).expect("graph should build");
    let output = runtime.render_frame(&[0.0, 0.25, 0.0, -0.75]);

    assert!((output[0] - 0.25).abs() < 1.0e-6);
    assert!((output[1] + 0.75).abs() < 1.0e-6);
}

#[test]
fn missing_hardware_input_channels_read_as_silence() {
    let mut spec = spec();
    spec.channels[0].hardware_input = Some([6, 7]);
    spec.clips.clear();
    spec.plugins.clear();

    let mut runtime = build(spec).expect("graph should build");

    assert!(is_silent(runtime.render_frame(&[0.5, 0.5])));
}

#[test]
fn the_sample_position_advances_only_while_the_transport_runs() {
    let mut runtime = runtime();

    let _ = runtime.render_frame(&[]);
    assert_eq!(runtime.diagnostic_snapshot().sample_position, 0);

    runtime.set_transport(RenderTransport::Playing);
    let _ = runtime.render_frame(&[]);
    assert_eq!(runtime.diagnostic_snapshot().sample_position, 1);

    runtime.set_transport(RenderTransport::Recording);
    let _ = runtime.render_frame(&[]);
    assert_eq!(runtime.diagnostic_snapshot().sample_position, 2);
    assert_eq!(runtime.transport(), RenderTransport::Recording);

    runtime.set_transport(RenderTransport::Stopped);
    let _ = runtime.render_frame(&[]);
    assert_eq!(runtime.diagnostic_snapshot().sample_position, 2);
}

#[test]
fn render_block_fills_every_requested_frame() {
    let mut runtime = runtime();
    runtime.set_transport(RenderTransport::Playing);
    let mut output = [[0.0f32; 32]; 4];

    runtime.render_block(&[], &mut output);

    assert_eq!(runtime.diagnostic_snapshot().sample_position, 4);
    for frame in output {
        assert!((frame[0] - 0.25).abs() < 1.0e-6);
    }
}

#[test]
fn the_diagnostic_snapshot_counts_the_graph_the_host_built() {
    let runtime = runtime();

    assert_eq!(
        runtime.diagnostic_snapshot(),
        crate::RenderDiagnosticSnapshot {
            sample_position: 0,
            channel_count: 3,
            clip_count: 1,
            plugin_count: 1,
            transport: RenderTransport::Stopped,
        }
    );
}

#[test]
fn channel_and_send_lookups_go_through_the_mixer_graph() {
    let mut spec = spec();
    spec.sends = vec![RenderSendSpec {
        id: "send".into(),
        source_channel_id: "audio".into(),
        target: RenderRoute::Channel("output".into()),
        enabled: true,
        tap: RenderSendTap::PostPan,
        level_db: -6.0,
    }];
    let runtime = build(spec).expect("graph with a send should build");

    assert_eq!(runtime.channel_count(), 3);
    assert_eq!(runtime.channel_index("audio"), Some(0));
    assert_eq!(runtime.channel_index("nowhere"), None);
    assert_eq!(runtime.send_index("send"), Some(0));
    assert_eq!(runtime.send_index("nowhere"), None);
}

#[test]
fn parameter_previews_reach_the_processor_and_are_clamped() {
    let plugin = RecordingPlugin::default();
    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(ConstantClip));
    resources.insert_plugin("gain", Box::new(plugin.clone()));
    let mut runtime =
        RenderRuntime::build(spec(), resources).expect("graph with a probe should build");

    runtime.preview_plugin_parameter(0, 7, 1.5);
    runtime.preview_plugin_parameter(0, 8, -0.5);
    runtime.preview_plugin_parameter(0, 9, 0.25);
    runtime.preview_plugin_parameter(9, 10, 0.5);

    let parameters = plugin
        .parameters
        .lock()
        .expect("parameter log should not be poisoned")
        .clone();
    assert_eq!(parameters, vec![(7, 1.0), (8, 0.0), (9, 0.25)]);
}

#[test]
fn gain_and_pan_previews_reject_channels_outside_the_graph() {
    let mut runtime = runtime();

    assert!(runtime.preview_channel_gain(0, -6.0).is_ok());
    assert!(runtime.preview_channel_pan(0, 1.0).is_ok());
    assert!(runtime.preview_channel_gain(9, -6.0).is_err());
    assert!(runtime.preview_channel_pan(9, 0.0).is_err());
    assert!(runtime.preview_send_level(0, -6.0).is_err());
}

#[test]
fn midi_notes_start_and_stop_on_their_own_ticks() {
    let plugin = RecordingPlugin::default();
    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(ConstantClip));
    resources.insert_plugin("gain", Box::new(plugin.clone()));
    let mut spec = spec();
    spec.midi = vec![RenderMidiSpec {
        plugin_id: "plugin".into(),
        notes: vec![RenderMidiNote {
            start_tick: 0,
            duration_ticks: 960,
            channel: 1,
            key: 60,
            velocity: 100,
            release_velocity: 64,
        }],
    }];
    let mut runtime = RenderRuntime::build(spec, resources).expect("MIDI graph should build");
    runtime.set_transport(RenderTransport::Playing);

    let _ = runtime.render_frame(&[]);
    assert_eq!(plugin.take_notes(), vec![NoteEvent::On(1, 60, 100)]);

    // One quarter note at 120 BPM is half a second of frames.
    runtime.seek(24_000);
    plugin.take_notes();
    let _ = runtime.render_frame(&[]);
    assert_eq!(plugin.take_notes(), vec![NoteEvent::Off(1, 60, 64)]);
}

#[test]
fn seeking_chases_notes_that_should_already_be_sounding() {
    let plugin = RecordingPlugin::default();
    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(ConstantClip));
    resources.insert_plugin("gain", Box::new(plugin.clone()));
    let mut spec = spec();
    spec.midi = vec![RenderMidiSpec {
        plugin_id: "plugin".into(),
        notes: vec![RenderMidiNote {
            start_tick: 0,
            duration_ticks: 960,
            channel: 0,
            key: 48,
            velocity: 90,
            release_velocity: 32,
        }],
    }];
    let mut runtime = RenderRuntime::build(spec, resources).expect("MIDI graph should build");
    plugin.take_notes();

    runtime.seek(12_000);
    assert_eq!(plugin.take_notes(), vec![NoteEvent::On(0, 48, 90)]);
    assert_eq!(runtime.diagnostic_snapshot().sample_position, 12_000);

    runtime.seek(48_000);
    assert_eq!(plugin.take_notes(), vec![NoteEvent::Off(0, 48, 32)]);
}

#[test]
fn processors_receive_the_musical_position_of_each_frame() {
    let probe = ContextProbe::default();
    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(ConstantClip));
    resources.insert_plugin("gain", Box::new(probe.clone()));
    let mut spec = spec();
    spec.time_signature_events = vec![TimeSignatureEvent {
        tick: 0,
        numerator: 6,
        denominator: 8,
    }];
    let mut runtime = RenderRuntime::build(spec, resources).expect("graph should build");
    runtime.set_transport(RenderTransport::Recording);

    runtime.seek(24_000);
    let _ = runtime.render_frame(&[]);

    let contexts = probe.0.lock().expect("context log should not be poisoned");
    let context = contexts.last().copied().expect("one frame was rendered");
    assert_eq!(context.sample_position, 24_000);
    assert!((context.quarter_position - 1.0).abs() < 1.0e-9);
    assert!((context.bar_position - 1.0 / 3.0).abs() < 1.0e-9);
    assert!((context.tempo - 120.0).abs() < 1.0e-9);
    assert_eq!(context.time_signature_numerator, 6);
    assert_eq!(context.time_signature_denominator, 8);
    assert!(context.playing);
    assert!(context.recording);
}

#[test]
fn the_context_follows_the_tempo_and_signature_in_effect_at_the_playhead() {
    let probe = ContextProbe::default();
    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(ConstantClip));
    resources.insert_plugin("gain", Box::new(probe.clone()));
    let mut spec = spec();
    spec.tempo_events = vec![
        TempoEvent {
            tick: 0,
            beats_per_minute: 120.0,
        },
        TempoEvent {
            tick: 960,
            beats_per_minute: 60.0,
        },
    ];
    spec.time_signature_events = vec![
        TimeSignatureEvent {
            tick: 0,
            numerator: 4,
            denominator: 4,
        },
        TimeSignatureEvent {
            tick: 960,
            numerator: 3,
            denominator: 4,
        },
    ];
    let mut runtime = RenderRuntime::build(spec, resources).expect("graph should build");

    // Two quarter notes at 120 BPM lands exactly on the tick-960 change.
    runtime.seek(48_000);
    let _ = runtime.render_frame(&[]);

    let contexts = probe.0.lock().expect("context log should not be poisoned");
    let context = contexts.last().copied().expect("one frame was rendered");
    assert!((context.tempo - 60.0).abs() < 1.0e-9);
    assert_eq!(context.time_signature_numerator, 3);
    assert!(!context.playing);
    assert!(!context.recording);
}

#[test]
fn a_host_prepared_graph_routes_sources_through_the_shared_kernel() {
    fn core_channel(id: &str, kind: ChannelKind) -> ChannelSpec {
        ChannelSpec {
            id: id.into(),
            kind,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: None,
            input_bus: None,
            hardware_output: None,
        }
    }

    let mixer = MixerGraph::new(
        48_000,
        vec![
            ChannelSpec {
                output: Some(RouteTarget::Output(2)),
                ..core_channel("audio", ChannelKind::Audio)
            },
            core_channel("master", ChannelKind::Master),
            ChannelSpec {
                hardware_output: Some([0, 1]),
                ..core_channel("output", ChannelKind::Output)
            },
        ],
        vec![],
    )
    .expect("host graph should build");
    let tempo_map = crate::TempoMap::new(
        vec![TempoEvent {
            tick: 0,
            beats_per_minute: 120.0,
        }],
        vec![TimeSignatureEvent {
            tick: 0,
            numerator: 4,
            denominator: 4,
        }],
    )
    .expect("tempo map should build");
    let mut runtime = RenderRuntime::from_mixer_graph(48_000, mixer, tempo_map);

    assert_eq!(runtime.channel_count(), 3);
    assert_eq!(runtime.transport(), RenderTransport::Stopped);
    assert_eq!(runtime.diagnostic_snapshot().clip_count, 0);

    let output = runtime.process_channel_sources(&[[0.5, -0.5], [0.0, 0.0], [0.0, 0.0]], &mut {
        |_, frame| frame
    });
    assert!((output[0] - 0.5).abs() < 1.0e-6);
    assert!((output[1] + 0.5).abs() < 1.0e-6);
}

#[test]
fn block_processing_needs_prepared_scratch_and_then_matches_frame_rendering() {
    let mut runtime = runtime();
    let mut sources = [[0.25f32, 0.25], [0.0, 0.0], [0.0, 0.0]];
    let mut output = [[0.0f32; 32]; 1];

    assert!(
        runtime
            .process_channel_source_block(&mut sources, &mut output, &mut |_, _, _| {})
            .is_err()
    );

    runtime.prepare_block_processing(1);
    runtime
        .process_channel_source_block(&mut sources, &mut output, &mut |_, _, _| {})
        .expect("prepared scratch should accept a one-frame block");

    assert!((output[0][0] - 0.25).abs() < 1.0e-6);
}

#[test]
fn clearing_delays_leaves_the_graph_renderable() {
    let mut runtime = runtime();
    runtime.set_transport(RenderTransport::Playing);
    let _ = runtime.render_frame(&[]);

    runtime.clear_delays();

    let output = runtime.render_frame(&[]);
    assert!((output[0] - 0.25).abs() < 1.0e-6);
}
