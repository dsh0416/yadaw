use std::{hint::black_box, time::Duration};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use yadaw_dsp_render::{
    AudioClipSource, RenderChannelKind, RenderChannelSpec, RenderClipSpec, RenderGraphSpec,
    RenderResources, RenderRoute, RenderRuntime, RenderTransport, TempoEvent, TimeSignatureEvent,
};

struct ConstantClip {
    frames: u64,
}

impl AudioClipSource for ConstantClip {
    fn channels(&self) -> u32 {
        2
    }

    fn frame_count(&self) -> u64 {
        self.frames
    }

    fn sample(&self, frame: u64, channel: u32) -> f32 {
        let phase = (frame % 256) as f32 / 256.0;
        if channel == 0 { phase } else { -phase }
    }
}

fn runtime(sample_rate: u32, tracks: usize, clips: usize, clip_frames: u64) -> RenderRuntime {
    let mut resources = RenderResources::new();
    let mut channels = Vec::with_capacity(tracks + 1);
    let mut clip_specs = Vec::with_capacity(clips);
    for track in 0..tracks {
        channels.push(RenderChannelSpec {
            id: format!("track-{track}"),
            kind: RenderChannelKind::Audio,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: Some(RenderRoute::Channel("output".into())),
            input_bus: None,
            hardware_input: None,
            hardware_output: None,
        });
    }
    channels.push(RenderChannelSpec {
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
    });
    for clip in 0..clips {
        let source_id = format!("source-{clip}");
        resources.insert_clip(
            source_id.clone(),
            Box::new(ConstantClip {
                frames: clip_frames,
            }),
        );
        clip_specs.push(RenderClipSpec {
            id: format!("clip-{clip}"),
            source_id,
            channel_id: format!("track-{}", clip % tracks),
            start_frame: 0,
            source_offset_frames: 0,
            length_frames: clip_frames,
        });
    }
    let mut runtime = RenderRuntime::build(
        RenderGraphSpec {
            sample_rate,
            channels,
            sends: vec![],
            clips: clip_specs,
            plugins: vec![],
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
    .expect("benchmark graph should build");
    runtime.set_transport(RenderTransport::Playing);
    runtime
}

fn group<'a>(
    criterion: &'a mut Criterion,
    name: &str,
) -> criterion::BenchmarkGroup<'a, criterion::measurement::WallTime> {
    let mut group = criterion.benchmark_group(name);
    group
        .warm_up_time(Duration::from_secs(3))
        .measurement_time(Duration::from_secs(5))
        .sample_size(100)
        .noise_threshold(0.03);
    group
}

fn timeline_complexity(c: &mut Criterion) {
    let mut group = group(c, "dsp-render/runtime/timeline_complexity");
    let block_frames = 256_usize;
    group.throughput(Throughput::Elements(block_frames as u64));
    for &(tracks, clips) in &[(1, 1), (16, 64), (32, 128), (64, 512)] {
        let mut runtime = runtime(48_000, tracks, clips, 1_000_000);
        let mut output = vec![[0.0; 32]; block_frames];
        group.bench_with_input(
            BenchmarkId::new("block=256", format!("tracks={tracks}/clips={clips}")),
            &block_frames,
            |bencher, _| {
                bencher.iter(|| runtime.render_block(&[], black_box(&mut output)));
            },
        );
    }
    group.finish();
}

fn sample_rates_and_blocks(c: &mut Criterion) {
    let mut group = group(c, "dsp-render/runtime/sample_rate_and_block");
    for &sample_rate in &[48_000_u32, 96_000] {
        for &block_frames in &[64_usize, 256, 1_024] {
            group.throughput(Throughput::Elements(block_frames as u64));
            let mut runtime = runtime(sample_rate, 32, 64, 1_000_000);
            let mut output = vec![[0.0; 32]; block_frames];
            group.bench_function(format!("{sample_rate}Hz/block={block_frames}"), |bencher| {
                bencher.iter(|| runtime.render_block(&[], black_box(&mut output)));
            });
        }
    }
    group.finish();
}

fn control_and_meter(c: &mut Criterion) {
    let mut group = group(c, "dsp-render/runtime/control_and_meter");
    let mut runtime = runtime(48_000, 128, 128, 1_000_000);
    let mut gain = -18.0_f32;
    group.bench_function("parameter-preview", |bencher| {
        bencher.iter(|| {
            gain = if gain == -18.0 { -6.0 } else { -18.0 };
            runtime
                .preview_channel_gain(black_box(0), black_box(gain))
                .expect("valid gain");
        });
    });
    let mut meters = vec![
        yadaw_dsp_render::RenderMeter {
            pre: [0.0; 2],
            post: [0.0; 2],
        };
        129
    ];
    group.bench_function("meter-snapshot/channels=129", |bencher| {
        bencher.iter(|| runtime.write_meters(black_box(&mut meters)));
    });
    group.finish();
}

criterion_group!(
    benches,
    timeline_complexity,
    sample_rates_and_blocks,
    control_and_meter
);
criterion_main!(benches);
