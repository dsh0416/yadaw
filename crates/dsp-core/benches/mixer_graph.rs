use std::{hint::black_box, time::Duration};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use yadaw_dsp_core::mixer::{
    ChannelFormat, ChannelKind, ChannelPeak, ChannelSpec, GraphError, MixerGraph, SendSpec,
    SendTap, StereoFrame,
};

#[derive(Clone, Copy)]
enum Topology {
    Direct,
    Cascaded,
    SendHeavy,
}

impl Topology {
    fn label(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Cascaded => "cascaded",
            Self::SendHeavy => "send-heavy",
        }
    }
}

fn scenario(
    tracks: usize,
    buses: usize,
    sends_per_track: usize,
    topology: Topology,
    soloed: bool,
) -> (Vec<ChannelSpec>, Vec<SendSpec>) {
    let master = tracks + buses;
    let mut channels = Vec::with_capacity(master + 1);
    for index in 0..tracks {
        let output = match topology {
            Topology::Direct => master,
            Topology::Cascaded | Topology::SendHeavy if buses > 0 => tracks + index % buses,
            Topology::Cascaded | Topology::SendHeavy => master,
        };
        channels.push(ChannelSpec {
            id: format!("audio-{index}"),
            kind: ChannelKind::Audio,
            format: if index % 2 == 0 {
                ChannelFormat::Stereo
            } else {
                ChannelFormat::Mono
            },
            gain_db: -3.0,
            pan: (index % 5) as f32 * 0.2 - 0.4,
            muted: index % 17 == 16,
            soloed: soloed && index == 0,
            output: Some(output),
        });
    }
    for index in 0..buses {
        let output = match topology {
            Topology::Cascaded if index + 1 < buses => tracks + index + 1,
            _ => master,
        };
        channels.push(ChannelSpec {
            id: format!("bus-{index}"),
            kind: ChannelKind::Bus,
            format: ChannelFormat::Stereo,
            gain_db: -1.0,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: Some(output),
        });
    }
    channels.push(ChannelSpec {
        id: "master".to_owned(),
        kind: ChannelKind::Master,
        format: ChannelFormat::Stereo,
        gain_db: 0.0,
        pan: 0.0,
        muted: false,
        soloed: false,
        output: None,
    });

    let mut sends = Vec::with_capacity(tracks.saturating_mul(sends_per_track));
    if buses > 0 {
        for source in 0..tracks {
            for send_index in 0..sends_per_track {
                let target = tracks + (source + send_index) % buses;
                sends.push(SendSpec {
                    id: format!("send-{source}-{send_index}"),
                    source,
                    target,
                    enabled: true,
                    tap: if send_index % 2 == 0 {
                        SendTap::Pre
                    } else {
                        SendTap::Post
                    },
                    level_db: -12.0,
                    pan: (send_index % 3) as f32 * 0.5 - 0.5,
                });
            }
        }
    }
    (channels, sends)
}

fn process_block(
    graph: &mut MixerGraph,
    inputs: &[StereoFrame],
    block_frames: usize,
) -> StereoFrame {
    let mut result = [0.0, 0.0];
    for _ in 0..block_frames {
        result = graph.process_frame(black_box(inputs));
    }
    result
}

fn bench_graph_build(c: &mut Criterion) {
    let mut group = c.benchmark_group("dsp-core/mixer_graph/build");
    group
        .warm_up_time(Duration::from_secs(3))
        .measurement_time(Duration::from_secs(5))
        .sample_size(100)
        .noise_threshold(0.03);

    for &(tracks, buses, sends_per_track, topology) in &[
        (1, 0, 0, Topology::Direct),
        (8, 4, 1, Topology::Cascaded),
        (32, 4, 1, Topology::SendHeavy),
        (128, 16, 4, Topology::SendHeavy),
    ] {
        let (channels, sends) = scenario(tracks, buses, sends_per_track, topology, true);
        let id = format!(
            "{}/tracks={tracks}/buses={buses}/sends={}",
            topology.label(),
            sends.len()
        );
        group.bench_function(id, |bencher| {
            bencher.iter(|| {
                black_box(
                    MixerGraph::new(48_000, channels.clone(), sends.clone())
                        .expect("benchmark graph must be valid"),
                )
            });
        });
    }

    let (mut channels, sends) = scenario(32, 4, 0, Topology::Cascaded, false);
    channels[32 + 3].output = Some(32);
    group.bench_function("reject-routing-cycle/channels=37", |bencher| {
        bencher.iter(|| {
            let result = MixerGraph::new(48_000, channels.clone(), sends.clone());
            assert!(matches!(result, Err(GraphError::RoutingCycle)));
        });
    });
    group.finish();
}

fn bench_process_complexity(c: &mut Criterion) {
    let mut group = c.benchmark_group("dsp-core/mixer_graph/process_complexity");
    group
        .warm_up_time(Duration::from_secs(3))
        .measurement_time(Duration::from_secs(5))
        .sample_size(100)
        .noise_threshold(0.03)
        .throughput(Throughput::Elements(256));

    for &sample_rate in &[48_000, 96_000] {
        for &(tracks, buses, sends_per_track, topology) in &[
            (1, 0, 0, Topology::Direct),
            (8, 0, 0, Topology::Direct),
            (32, 4, 0, Topology::Cascaded),
            (32, 4, 1, Topology::SendHeavy),
            (128, 16, 4, Topology::SendHeavy),
        ] {
            let (channels, sends) = scenario(tracks, buses, sends_per_track, topology, false);
            let mut graph = MixerGraph::new(sample_rate, channels, sends).expect("benchmark graph");
            let inputs = vec![[0.125, -0.125]; tracks];
            let parameter = format!(
                "{}Hz/{}/tracks={tracks}/buses={buses}/sends-per-track={sends_per_track}",
                sample_rate,
                topology.label()
            );
            group.bench_with_input(
                BenchmarkId::new("block=256", parameter),
                &256_usize,
                |bencher, block_frames| {
                    bencher.iter(|| black_box(process_block(&mut graph, &inputs, *block_frames)));
                },
            );
        }
    }
    group.finish();
}

fn bench_block_sizes_and_branches(c: &mut Criterion) {
    let mut group = c.benchmark_group("dsp-core/mixer_graph/block_and_branches");
    group
        .warm_up_time(Duration::from_secs(3))
        .measurement_time(Duration::from_secs(5))
        .sample_size(100)
        .noise_threshold(0.03);

    for &block_frames in &[64_usize, 256, 1_024] {
        group.throughput(Throughput::Elements(block_frames as u64));
        for &soloed in &[false, true] {
            let (channels, sends) = scenario(32, 4, 1, Topology::SendHeavy, soloed);
            let mut graph = MixerGraph::new(48_000, channels, sends).expect("benchmark graph");
            let inputs = vec![[0.25, 0.125]; 32];
            let parameter = format!(
                "block={block_frames}/solo={}",
                if soloed { "on" } else { "off" }
            );
            group.bench_function(parameter, |bencher| {
                bencher.iter(|| black_box(process_block(&mut graph, &inputs, block_frames)));
            });
        }
    }
    group.finish();
}

fn bench_parameters_and_meters(c: &mut Criterion) {
    let (channels, sends) = scenario(128, 16, 1, Topology::SendHeavy, false);
    let mut graph = MixerGraph::new(48_000, channels, sends).expect("benchmark graph");
    let inputs = vec![[0.25, -0.125]; 128];
    let mut peaks = vec![ChannelPeak::default(); graph.channel_count()];

    let mut group = c.benchmark_group("dsp-core/mixer_graph/parameters_and_meters");
    group
        .warm_up_time(Duration::from_secs(3))
        .measurement_time(Duration::from_secs(5))
        .sample_size(100)
        .noise_threshold(0.03);
    group.bench_function("preview-smooth-and-render/block=256", |bencher| {
        bencher.iter(|| {
            graph.set_channel_gain(0, -18.0).expect("valid gain");
            graph.set_channel_pan(0, 0.75).expect("valid pan");
            black_box(process_block(&mut graph, &inputs, 256))
        });
    });
    group.bench_function("write-and-clear-peaks/channels=145", |bencher| {
        bencher.iter(|| {
            graph.write_peaks(black_box(&mut peaks));
            black_box(&peaks);
        });
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_graph_build,
    bench_process_complexity,
    bench_block_sizes_and_branches,
    bench_parameters_and_meters
);
criterion_main!(benches);
