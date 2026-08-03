use std::{
    fs,
    hint::black_box,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use heron_audio_host::engine::bench_support::{StreamingHarness, decode_clip};
use heron_dsp_node::bench_support::write_float_fixture;

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
            "heron-criterion-media-{}-{nonce}",
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

fn prepare_fixtures(directory: &FixtureDirectory) -> (PathBuf, PathBuf, PathBuf, u64, u64, u64) {
    let small_mono = directory.file("small-44k-mono.bwf");
    let small_stereo = directory.file("small-44k-stereo.bwf");
    let large = directory.file("large-48k-stereo.bwf");
    let mono_bytes = write_float_fixture(&small_mono, 44_100, 1, 44_100 * 10);
    let stereo_bytes = write_float_fixture(&small_stereo, 44_100, 2, 44_100 * 10);
    let large_bytes = write_float_fixture(&large, 48_000, 2, 48_000 * 96);
    assert!(mono_bytes < 32 * 1024 * 1024);
    assert!(stereo_bytes < 32 * 1024 * 1024);
    assert!(large_bytes > 32 * 1024 * 1024);
    (
        small_mono,
        small_stereo,
        large,
        mono_bytes,
        stereo_bytes,
        large_bytes,
    )
}

fn bench_decode(c: &mut Criterion) {
    let directory = FixtureDirectory::new();
    let (mono, stereo, _large, mono_bytes, stereo_bytes, _) = prepare_fixtures(&directory);
    let mut group = io_group(c, "dsp-node/media_streaming/decode");
    for &(format, path, bytes) in &[
        ("mono-10s", &mono, mono_bytes),
        ("stereo-10s", &stereo, stereo_bytes),
    ] {
        group.throughput(Throughput::Bytes(bytes));
        for &target_rate in &[44_100_u32, 48_000] {
            group.bench_with_input(
                BenchmarkId::new(format, format!("44100-to-{target_rate}")),
                &target_rate,
                |bencher, target| {
                    bencher.iter(|| {
                        black_box(decode_clip(black_box(path_text(path)), black_box(*target)))
                    });
                },
            );
        }
    }
    group.finish();
}

fn path_text(path: &Path) -> &str {
    path.to_str().expect("benchmark path is UTF-8")
}

fn bench_streaming(c: &mut Criterion) {
    let directory = FixtureDirectory::new();
    let (_mono, _stereo, large, _, _, _large_bytes) = prepare_fixtures(&directory);
    let block_frames = 256_usize;
    let mut cached = StreamingHarness::open(path_text(&large), 48_000, block_frames);

    let mut cached_group = c.benchmark_group("dsp-node/media_streaming/cached_window");
    cached_group
        .warm_up_time(Duration::from_secs(3))
        .measurement_time(Duration::from_secs(5))
        .sample_size(100)
        .noise_threshold(0.03)
        .throughput(Throughput::Elements(block_frames as u64));
    cached_group.bench_function("stereo/block=256", |bencher| {
        bencher.iter(|| black_box(cached.read_cached_block()));
    });
    cached_group.finish();

    let mut seek = StreamingHarness::open(path_text(&large), 48_000, 1);
    let mut seek_group = io_group(c, "dsp-node/media_streaming/seek_refill");
    let targets = [48_000_usize * 8, 48_000 * 48, 48_000 * 88];
    let mut target_index = 0_usize;
    seek_group.bench_function("worker-refill/large-stereo", |bencher| {
        bencher.iter(|| {
            let target = targets[target_index % targets.len()];
            target_index += 1;
            black_box(seek.seek_and_refill(black_box(target)))
        });
    });
    seek_group.finish();
}

criterion_group!(benches, bench_decode, bench_streaming);
criterion_main!(benches);
