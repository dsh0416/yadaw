use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

use crate::{
    AudioClipSource, PluginProcessContext, PluginProcessor, RenderChannelKind, RenderChannelSpec,
    RenderClipSpec, RenderGraphSpec, RenderMeter, RenderPluginSpec, RenderResources, RenderRoute,
    RenderRuntime, RenderTransport, TempoEvent, TimeSignatureEvent,
};

struct TrackingAllocator;

static TRACK_ALLOCATIONS: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static DEALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

// SAFETY: Every operation is delegated unchanged to the process system
// allocator. The counters are diagnostic side effects only.
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK_ALLOCATIONS.load(Ordering::Relaxed) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
        // SAFETY: Delegating the caller-provided layout to the system allocator.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if TRACK_ALLOCATIONS.load(Ordering::Relaxed) {
            DEALLOCATIONS.fetch_add(1, Ordering::Relaxed);
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

fn runtime() -> RenderRuntime {
    let mut resources = RenderResources::new();
    resources.insert_clip("clip-source", Box::new(ConstantClip));
    resources.insert_plugin("gain", Box::new(GainPlugin(0.5)));
    RenderRuntime::build(
        RenderGraphSpec {
            sample_rate: 48_000,
            channels: vec![
                RenderChannelSpec {
                    id: "audio".into(),
                    kind: RenderChannelKind::Audio,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output: Some(RenderRoute::Channel("output".into())),
                    input_bus: None,
                    hardware_input: None,
                    hardware_output: None,
                },
                RenderChannelSpec {
                    id: "master".into(),
                    kind: RenderChannelKind::Master,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output: None,
                    input_bus: None,
                    hardware_input: None,
                    hardware_output: None,
                },
                RenderChannelSpec {
                    id: "output".into(),
                    kind: RenderChannelKind::Output,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output: None,
                    input_bus: None,
                    hardware_input: None,
                    hardware_output: Some([0, 1]),
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
        },
        resources,
    )
    .expect("deterministic render graph should build")
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

    ALLOCATIONS.store(0, Ordering::Relaxed);
    DEALLOCATIONS.store(0, Ordering::Relaxed);
    TRACK_ALLOCATIONS.store(true, Ordering::SeqCst);
    for _ in 0..32 {
        let _ = runtime.render_frame(&[]);
    }
    TRACK_ALLOCATIONS.store(false, Ordering::SeqCst);
    assert_eq!(ALLOCATIONS.load(Ordering::Relaxed), 0);
    assert_eq!(DEALLOCATIONS.load(Ordering::Relaxed), 0);
}
