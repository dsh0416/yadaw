use std::{
    fs,
    hint::black_box,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use criterion::{BatchSize, BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use heron_dsp_node::bench_support::{
    TapHarness, WaveformHarness, finalize_fixture, write_float_fixture, write_recording_session,
};

struct FixtureDirectory {
    path: PathBuf,
}

impl FixtureDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time moves forward")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "heron-criterion-recording-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create benchmark fixture directory");
        Self { path }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

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

fn io_group<'a>(
    criterion: &'a mut Criterion,
    name: &str,
) -> criterion::BenchmarkGroup<'a, criterion::measurement::WallTime> {
    let mut group = criterion.benchmark_group(name);
    group
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(10))
        .sample_size(10)
        .noise_threshold(0.10);
    group
}

fn bench_recording_tap(c: &mut Criterion) {
    let mut group = cpu_group(c, "dsp-node/recording/tap");
    for &channels in &[2_usize, 8, 32] {
        for &block_frames in &[64_usize, 256] {
            group.throughput(Throughput::Elements(block_frames as u64));
            group.bench_with_input(
                BenchmarkId::new(
                    "callback",
                    format!("channels={channels}/block={block_frames}"),
                ),
                &(channels, block_frames),
                |bencher, &(channels, block_frames)| {
                    bencher.iter_batched_ref(
                        || TapHarness::new(channels, block_frames),
                        |harness| {
                            harness.push_block();
                            black_box(harness.block_frames())
                        },
                        BatchSize::PerIteration,
                    );
                },
            );
        }
    }
    group.finish();
}

fn bench_waveform(c: &mut Criterion) {
    let mut group = cpu_group(c, "dsp-node/recording/waveform");
    for &frames in &[2_048_usize, 48_000] {
        group.throughput(Throughput::Elements(frames as u64));
        group.bench_function(format!("stereo/frames={frames}"), |bencher| {
            bencher.iter_batched_ref(
                || WaveformHarness::new(48_000, 2, frames),
                |waveform| waveform.push(),
                BatchSize::PerIteration,
            );
        });
    }
    group.finish();
}

fn bench_writer(c: &mut Criterion) {
    let directory = FixtureDirectory::new();
    let output = directory.file("writer-session.bwf");
    let frames = 48_000_usize;
    let mut group = io_group(c, "dsp-node/recording/writer");
    group.throughput(Throughput::Elements(frames as u64));
    for &channels in &[2_usize, 8, 32] {
        group.bench_function(format!("channels={channels}/duration=1s"), |bencher| {
            bencher.iter(|| {
                black_box(write_recording_session(
                    &output, 48_000, channels, frames, 256,
                ))
            });
        });
    }
    group.finish();
}

fn bench_finalize(c: &mut Criterion) {
    let directory = FixtureDirectory::new();
    let native_input = directory.file("input-48k-stereo.bwf");
    let resample_input = directory.file("input-44k-stereo.bwf");
    let _ = write_float_fixture(&native_input, 48_000, 2, 48_000 * 10);
    let _ = write_float_fixture(&resample_input, 44_100, 2, 44_100 * 10);
    let mut group = io_group(c, "dsp-node/recording/finalize");
    group.throughput(Throughput::Elements(480_000));
    for &(source_rate, input) in &[(48_000_u32, &native_input), (44_100_u32, &resample_input)] {
        for &bit_depth in &["float32", "pcm24", "pcm16"] {
            let output = directory.file(&format!("output-{source_rate}-{bit_depth}.bwf"));
            group.bench_function(
                format!("{source_rate}-to-48000/{bit_depth}/stereo-10s"),
                |bencher| {
                    bencher.iter(|| {
                        black_box(finalize_fixture(input, &output, 48_000, bit_depth, None))
                    });
                },
            );
        }
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_recording_tap,
    bench_waveform,
    bench_writer,
    bench_finalize
);
criterion_main!(benches);
