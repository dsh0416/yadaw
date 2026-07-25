#![cfg(feature = "bench-internals")]

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hint::black_box,
};

use yadaw_dsp_core::mixer::{ChannelKind, ChannelSpec, MixerGraph};
use yadaw_dsp_node::bench_support::{
    ParameterQueueHarness, RenderHarness, RenderScenario, TapHarness,
};

thread_local! {
    static TRACKING: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    static DEALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

struct ThreadCountingAllocator;

#[global_allocator]
static ALLOCATOR: ThreadCountingAllocator = ThreadCountingAllocator;

unsafe impl GlobalAlloc for ThreadCountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        TRACKING.with(|tracking| {
            if tracking.get() {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        TRACKING.with(|tracking| {
            if tracking.get() {
                DEALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        TRACKING.with(|tracking| {
            if tracking.get() {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        TRACKING.with(|tracking| {
            if tracking.get() {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
                DEALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
        });
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
            output: Some(2),
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
}
