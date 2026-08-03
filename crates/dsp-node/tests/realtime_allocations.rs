#![cfg(feature = "bench-internals")]

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hint::black_box,
};

use heron_audio_host::engine::bench_support::{
    ParameterQueueHarness, PluginAdapterHarness, RenderHarness, RenderScenario,
    SessionRateBridgeHarness,
};
use heron_dsp_core::mixer::{ChannelKind, ChannelSpec, MixerGraph, RouteTarget};
use heron_dsp_node::bench_support::TapHarness;

thread_local! {
    static TRACKING: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    static DEALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

struct ThreadCountingAllocator;

#[global_allocator]
static ALLOCATOR: ThreadCountingAllocator = ThreadCountingAllocator;

// SAFETY: every method delegates to the `System` allocator and only adds
// side-effect-free thread-local counting, so the `GlobalAlloc` contract is
// upheld by `System`.
unsafe impl GlobalAlloc for ThreadCountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        TRACKING.with(|tracking| {
            if tracking.get() {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        // SAFETY: the caller upholds the `GlobalAlloc::alloc` contract.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        TRACKING.with(|tracking| {
            if tracking.get() {
                DEALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        // SAFETY: the caller upholds the `GlobalAlloc::dealloc` contract.
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        TRACKING.with(|tracking| {
            if tracking.get() {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        // SAFETY: the caller upholds the `GlobalAlloc::alloc_zeroed` contract.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        TRACKING.with(|tracking| {
            if tracking.get() {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
                DEALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        // SAFETY: the caller upholds the `GlobalAlloc::realloc` contract.
        unsafe { System.realloc(pointer, layout, new_size) }
    }
}

fn assert_no_thread_allocations(label: &str, operation: impl FnOnce()) {
    TRACKING.with(|tracking| tracking.set(false));
    ALLOCATIONS.with(|count| count.set(0));
    DEALLOCATIONS.with(|count| count.set(0));
    TRACKING.with(|tracking| tracking.set(true));
    operation();
    TRACKING.with(|tracking| tracking.set(false));
    let allocations = ALLOCATIONS.with(Cell::get);
    let deallocations = DEALLOCATIONS.with(Cell::get);
    assert_eq!(
        (allocations, deallocations),
        (0, 0),
        "{label} allocated {allocations} times and deallocated {deallocations} times"
    );
}

#[test]
fn realtime_mixer_render_preview_and_capture_do_not_allocate() {
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
    let mut graph = MixerGraph::new(48_000, channels, Vec::new()).expect("valid graph");
    let input = [[0.25, -0.25]];
    let _ = graph.process_frame(&input);
    assert_no_thread_allocations("MixerGraph::process_frame", || {
        for _ in 0..256 {
            black_box(graph.process_frame(black_box(&input)));
        }
    });

    let mut render = RenderHarness::new(RenderScenario {
        sample_rate: 48_000,
        tracks: 32,
        total_clips: 64,
        active_clips: 32,
        clip_frames: 256,
    });
    let _ = render.render_block(256);
    assert_no_thread_allocations("NativeMixerRuntime::render_frame", || {
        black_box(render.render_block(256));
    });
    render.enable_stopped_monitoring();
    let monitored = render.render_monitoring_block(1, [0.25, -0.125]);
    assert!(monitored[0] > 0.1 && monitored[1] < -0.05);
    assert_no_thread_allocations("stopped software monitoring render", || {
        black_box(render.render_monitoring_block(256, black_box([0.25, -0.125])));
    });

    let mut adapters = PluginAdapterHarness::new();
    let _ = adapters.render_frame([0.25, -0.125]);
    assert_no_thread_allocations("all plugin channel adapter modes", || {
        for _ in 0..256 {
            black_box(adapters.render_frame(black_box([0.25, -0.125])));
        }
    });

    let mut preview = ParameterQueueHarness::new();
    preview.consume_preview(-6.0);
    assert_no_thread_allocations("preview command queue and application", || {
        preview.consume_preview(-18.0);
    });

    let mut tap = TapHarness::new(32, 256);
    tap.push_block();
    assert_eq!(tap.drain(), 256);
    assert_no_thread_allocations("RecordingTap::push", || {
        tap.push_block();
    });

    let mut rate_bridge = SessionRateBridgeHarness::new(48_000, 44_100, 48_000);
    let _ = rate_bridge.render_device_block(1_024);
    assert_no_thread_allocations("input/session/output rate bridge", || {
        black_box(rate_bridge.render_device_block(256));
    });
}
