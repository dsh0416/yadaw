use std::{hint::black_box, time::Duration};

use criterion::{BatchSize, BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use yadaw_audio_host::engine::bench_support::{
    GraphSwapHarness, ParameterQueueHarness, RenderHarness, RenderScenario, ResamplerHarness,
};

fn cpu_group<'a>(
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

fn bench_timeline_complexity(c: &mut Criterion) {
    let mut group = cpu_group(c, "dsp-node/native_render/timeline_complexity");
    let block_frames = 256_usize;
    group.throughput(Throughput::Elements(block_frames as u64));
    for &(total_clips, active_clips) in &[(1, 1), (64, 16), (1_000, 16), (10_000, 16), (64, 64)] {
        let scenario = RenderScenario {
            sample_rate: 48_000,
            tracks: 32,
            total_clips,
            active_clips,
            clip_frames: block_frames,
        };
        let mut harness = RenderHarness::new(scenario);
        group.bench_with_input(
            BenchmarkId::new(
                "block=256",
                format!("total={total_clips}/active={active_clips}"),
            ),
            &block_frames,
            |bencher, frames| {
                bencher.iter(|| black_box(harness.render_block(*frames)));
            },
        );
    }
    group.finish();
}

fn bench_sample_rates_and_blocks(c: &mut Criterion) {
    let mut group = cpu_group(c, "dsp-node/native_render/sample_rate_and_block");
    for &sample_rate in &[48_000_u32, 96_000] {
        for &block_frames in &[64_usize, 256, 1_024] {
            group.throughput(Throughput::Elements(block_frames as u64));
            let mut harness = RenderHarness::new(RenderScenario {
                sample_rate,
                tracks: 32,
                total_clips: 64,
                active_clips: 32,
                clip_frames: block_frames,
            });
            group.bench_function(
                format!("{sample_rate}Hz/block={block_frames}/active=32"),
                |bencher| {
                    bencher.iter(|| black_box(harness.render_block(block_frames)));
                },
            );
        }
    }
    group.finish();
}

fn bench_control_and_meter(c: &mut Criterion) {
    let mut group = cpu_group(c, "dsp-node/native_render/control_and_meter");
    let mut parameters = ParameterQueueHarness::new();
    let mut value = -18.0_f32;
    group.bench_function("bounded-queue/preview-and-apply", |bencher| {
        bencher.iter(|| {
            value = if value == -18.0 { -6.0 } else { -18.0 };
            parameters.consume_preview(black_box(value));
        });
    });

    let scenario = RenderScenario {
        sample_rate: 48_000,
        tracks: 128,
        total_clips: 128,
        active_clips: 128,
        clip_frames: 256,
    };
    let mut meter = RenderHarness::new(scenario);
    let _ = meter.render_block(256);
    group.bench_function("publish-meter/channels=129", |bencher| {
        bencher.iter(|| meter.publish_meters(256));
    });

    let mut swap = GraphSwapHarness::new(RenderScenario {
        sample_rate: 48_000,
        tracks: 32,
        total_clips: 64,
        active_clips: 32,
        clip_frames: 256,
    });
    group.bench_function("block-boundary-graph-swap/channels=33", |bencher| {
        bencher.iter(|| swap.swap_at_block_boundary());
    });
    group.finish();
}

fn bench_adaptive_resampler(c: &mut Criterion) {
    let mut group = cpu_group(c, "dsp-node/native_render/adaptive_resampler");
    let output_frames = 256_usize;
    group.throughput(Throughput::Elements(output_frames as u64));
    for &(input_rate, output_rate) in &[(48_000, 48_000), (44_100, 48_000), (48_000, 44_100)] {
        group.bench_function(
            format!("{input_rate}-to-{output_rate}/block=256"),
            |bencher| {
                bencher.iter_batched(
                    || ResamplerHarness::new(input_rate, output_rate, output_frames),
                    |mut harness| black_box(harness.render()),
                    BatchSize::PerIteration,
                );
            },
        );
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_timeline_complexity,
    bench_sample_rates_and_blocks,
    bench_control_and_meter,
    bench_adaptive_resampler
);
criterion_main!(benches);
