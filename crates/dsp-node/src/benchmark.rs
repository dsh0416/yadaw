use std::{
    hint::black_box,
    time::{Duration, Instant},
};

use napi::{Result, Task, bindgen_prelude::AsyncTask};
use napi_derive::napi;
use yadaw_dsp_core::mixer::{ChannelKind, ChannelSpec, MixerGraph, SendSpec, SendTap, StereoFrame};

const SAMPLE_RATE: u32 = 48_000;
const TARGET_MEASUREMENT_TIME: Duration = Duration::from_millis(200);
const MAX_VIRTUAL_FRAMES: usize = SAMPLE_RATE as usize * 120;

#[derive(Clone, Copy)]
struct Scenario {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    block_frames: usize,
    tracks: usize,
    buses: usize,
    sends: usize,
}

const SCENARIOS: [Scenario; 3] = [
    Scenario {
        id: "low-latency-tracking",
        label: "Low-latency tracking",
        description: "16 tracks at a 64-sample buffer",
        block_frames: 64,
        tracks: 16,
        buses: 2,
        sends: 8,
    },
    Scenario {
        id: "production-mix",
        label: "Production mix",
        description: "48 tracks with buses and sends",
        block_frames: 128,
        tracks: 48,
        buses: 4,
        sends: 24,
    },
    Scenario {
        id: "dense-session",
        label: "Dense session",
        description: "96 tracks with a layered routing graph",
        block_frames: 256,
        tracks: 96,
        buses: 8,
        sends: 48,
    },
];

#[napi(object)]
pub struct NativeAudioBenchmarkScenario {
    pub id: String,
    pub label: String,
    pub description: String,
    pub sample_rate: u32,
    pub block_size: u32,
    pub tracks: u32,
    pub buses: u32,
    pub sends: u32,
    pub elapsed_ms: f64,
    pub audio_duration_ms: f64,
    pub average_block_ms: f64,
    pub buffer_budget_ms: f64,
    pub realtime_factor: f64,
}

#[napi(object)]
pub struct NativeAudioBenchmarkReport {
    pub duration_ms: f64,
    pub overall_realtime_factor: f64,
    pub scenarios: Vec<NativeAudioBenchmarkScenario>,
}

fn build_graph(scenario: Scenario) -> MixerGraph {
    let master = scenario.tracks + scenario.buses;
    let output = master + 1;
    let mut channels = Vec::with_capacity(master + 2);

    for index in 0..scenario.tracks {
        channels.push(ChannelSpec {
            id: format!("track-{index}"),
            kind: ChannelKind::Audio,
            gain_db: -3.0,
            pan: (index % 5) as f32 * 0.2 - 0.4,
            muted: false,
            soloed: false,
            output: Some(scenario.tracks + index % scenario.buses),
            hardware_output: None,
        });
    }

    for index in 0..scenario.buses {
        channels.push(ChannelSpec {
            id: format!("bus-{index}"),
            kind: ChannelKind::Bus,
            gain_db: -1.5,
            pan: 0.0,
            muted: false,
            soloed: false,
            output: Some(output),
            hardware_output: None,
        });
    }

    channels.push(ChannelSpec {
        id: "master".to_owned(),
        kind: ChannelKind::Master,
        gain_db: 0.0,
        pan: 0.0,
        muted: false,
        soloed: false,
        output: None,
        hardware_output: None,
    });
    channels.push(ChannelSpec {
        id: "output".to_owned(),
        kind: ChannelKind::Output,
        gain_db: 0.0,
        pan: 0.0,
        muted: false,
        soloed: false,
        output: None,
        hardware_output: Some([0, 1]),
    });

    let sends = (0..scenario.sends)
        .map(|index| SendSpec {
            id: format!("send-{index}"),
            source: index % scenario.tracks,
            target: scenario.tracks + (index + 1) % scenario.buses,
            enabled: true,
            tap: if index % 4 == 0 {
                SendTap::Pre
            } else {
                SendTap::Post
            },
            level_db: -12.0,
            pan: 0.0,
        })
        .collect();

    MixerGraph::new(SAMPLE_RATE, channels, sends).expect("benchmark graph must be valid")
}

fn measure_scenario(
    scenario: Scenario,
    target_time: Duration,
    max_virtual_frames: usize,
) -> NativeAudioBenchmarkScenario {
    let mut graph = build_graph(scenario);
    let inputs: Vec<StereoFrame> = (0..scenario.tracks)
        .map(|index| {
            let sample = 0.01 + index as f32 * 0.0001;
            [sample, -sample * 0.75]
        })
        .collect();

    for _ in 0..8 {
        for _ in 0..scenario.block_frames {
            black_box(graph.process_frame(black_box(&inputs)));
        }
    }

    let started = Instant::now();
    let mut rendered_frames = 0_usize;
    let mut rendered_blocks = 0_usize;
    while rendered_frames < max_virtual_frames {
        for _ in 0..scenario.block_frames {
            black_box(graph.process_frame(black_box(&inputs)));
        }
        rendered_frames += scenario.block_frames;
        rendered_blocks += 1;
        if started.elapsed() >= target_time {
            break;
        }
    }

    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let audio_duration_ms = rendered_frames as f64 / f64::from(SAMPLE_RATE) * 1_000.0;
    let average_block_ms = elapsed_ms / rendered_blocks.max(1) as f64;
    let buffer_budget_ms = scenario.block_frames as f64 / f64::from(SAMPLE_RATE) * 1_000.0;

    NativeAudioBenchmarkScenario {
        id: scenario.id.to_owned(),
        label: scenario.label.to_owned(),
        description: scenario.description.to_owned(),
        sample_rate: SAMPLE_RATE,
        block_size: scenario.block_frames as u32,
        tracks: scenario.tracks as u32,
        buses: scenario.buses as u32,
        sends: scenario.sends as u32,
        elapsed_ms,
        audio_duration_ms,
        average_block_ms,
        buffer_budget_ms,
        realtime_factor: audio_duration_ms / elapsed_ms.max(f64::EPSILON),
    }
}

fn run_suite(target_time: Duration, max_virtual_frames: usize) -> NativeAudioBenchmarkReport {
    let started = Instant::now();
    let scenarios: Vec<_> = SCENARIOS
        .into_iter()
        .map(|scenario| measure_scenario(scenario, target_time, max_virtual_frames))
        .collect();
    let overall_realtime_factor = scenarios
        .iter()
        .map(|scenario| scenario.realtime_factor)
        .fold(f64::INFINITY, f64::min);

    NativeAudioBenchmarkReport {
        duration_ms: started.elapsed().as_secs_f64() * 1_000.0,
        overall_realtime_factor,
        scenarios,
    }
}

pub struct AudioBenchmarkTask;

#[napi]
impl Task for AudioBenchmarkTask {
    type Output = NativeAudioBenchmarkReport;
    type JsValue = NativeAudioBenchmarkReport;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(run_suite(TARGET_MEASUREMENT_TIME, MAX_VIRTUAL_FRAMES))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn run_audio_benchmark() -> AsyncTask<AudioBenchmarkTask> {
    AsyncTask::new(AudioBenchmarkTask)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{MAX_VIRTUAL_FRAMES, SCENARIOS, build_graph, run_suite};

    #[test]
    fn benchmark_scenarios_build_valid_graphs() {
        for scenario in SCENARIOS {
            let graph = build_graph(scenario);
            assert_eq!(graph.channel_count(), scenario.tracks + scenario.buses + 2);
        }
    }

    #[test]
    fn report_contains_finite_timing_results() {
        let report = run_suite(Duration::from_millis(1), MAX_VIRTUAL_FRAMES.min(48_000));

        assert_eq!(report.scenarios.len(), SCENARIOS.len());
        assert!(report.duration_ms > 0.0);
        assert!(report.overall_realtime_factor.is_finite());
        assert!(report.overall_realtime_factor > 0.0);
        for result in report.scenarios {
            assert!(result.average_block_ms > 0.0);
            assert!(result.buffer_budget_ms > 0.0);
            assert!(result.realtime_factor.is_finite());
        }
    }
}
