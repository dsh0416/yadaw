use std::hint::black_box;

use super::{
    Arc, AtomicBool, AtomicU32, AtomicU64, Duration, InputPeakBank, Instant, LiveMixerSendTap,
    MAX_INPUT_CHANNELS, MAX_OUTPUT_CHANNELS, NativeLatencyPolicy, NativeMixerChannel,
    NativeMixerGraph, NativeMixerRuntime, NativeMixerSend, NativePluginInstance, PluginAudioMode,
    TRANSPORT_STOPPED, TempoEvent, TimeSignatureEvent, TransportShared, Vst3ProcessorHandle,
    build_mixer_runtime,
};

use heron_dsp_runtime::protocol::{AudioBenchmarkReport, AudioBenchmarkScenario};

const BENCHMARK_SAMPLE_RATE: u32 = 48_000;
const TARGET_MEASUREMENT_TIME: Duration = Duration::from_millis(200);
const MAX_VIRTUAL_FRAMES: usize = BENCHMARK_SAMPLE_RATE as usize * 120;

#[derive(Clone, Copy)]
struct AudioBenchmarkSpec {
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) description: &'static str,
    pub(super) block_frames: usize,
    pub(super) tracks: usize,
    pub(super) buses: usize,
    pub(super) sends: usize,
    pub(super) plugins: usize,
}

const AUDIO_BENCHMARK_SPECS: [AudioBenchmarkSpec; 3] = [
    AudioBenchmarkSpec {
        id: "low-latency-tracking",
        label: "Low-latency tracking",
        description: "16 tracks and 8 VST3 effects at a 64-sample buffer",
        block_frames: 64,
        tracks: 16,
        buses: 2,
        sends: 8,
        plugins: 8,
    },
    AudioBenchmarkSpec {
        id: "production-mix",
        label: "Production mix",
        description: "48 tracks, 32 VST3 effects, buses, and sends",
        block_frames: 128,
        tracks: 48,
        buses: 4,
        sends: 24,
        plugins: 32,
    },
    AudioBenchmarkSpec {
        id: "dense-session",
        label: "Dense session",
        description: "96 tracks, 64 VST3 effects, and layered routing",
        block_frames: 256,
        tracks: 96,
        buses: 8,
        sends: 48,
        plugins: 64,
    },
];

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = (fraction.clamp(0.0, 1.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[index]
}

fn benchmark_graph(
    spec: AudioBenchmarkSpec,
    processors: &[(String, Vst3ProcessorHandle)],
) -> NativeMixerGraph {
    let master = spec.tracks + spec.buses;
    let output = master + 1;
    let mut channels = Vec::with_capacity(master + 2);

    for index in 0..spec.tracks {
        channels.push(NativeMixerChannel {
            name: format!("Audio {index}"),
            color: String::new(),
            id: format!("benchmark-track-{index}"),
            kind: "audio".into(),
            system_role: None,
            gain_db: -3.0,
            pan: (index % 5) as f64 * 0.2 - 0.4,
            muted: false,
            soloed: false,
            output_index: Some(output as u32),
            output_bus: None,
            record_armed: false,
            input_monitoring: true,
            input_source: Some("hardware".into()),
            input_channels: vec![1, 2],
            hardware_output_channels: Vec::new(),
            midi_input_port_id: None,
            midi_input_channel: None,
        });
    }

    for index in 0..spec.buses {
        channels.push(NativeMixerChannel {
            name: format!("Aux {index}"),
            color: String::new(),
            id: format!("benchmark-aux-{index}"),
            kind: "aux".into(),
            system_role: None,
            gain_db: -1.5,
            pan: 0.0,
            muted: false,
            soloed: false,
            output_index: Some(output as u32),
            output_bus: None,
            record_armed: false,
            input_monitoring: false,
            input_source: Some("bus".into()),
            input_channels: vec![(index + 1) as u32, (index + 1) as u32],
            hardware_output_channels: Vec::new(),
            midi_input_port_id: None,
            midi_input_channel: None,
        });
    }

    channels.push(NativeMixerChannel {
        name: "Master".into(),
        color: String::new(),
        id: "benchmark-master".into(),
        kind: "master".into(),
        system_role: None,
        gain_db: 0.0,
        pan: 0.0,
        muted: false,
        soloed: false,
        output_index: None,
        output_bus: None,
        record_armed: false,
        input_monitoring: false,
        input_source: None,
        input_channels: Vec::new(),
        hardware_output_channels: Vec::new(),
        midi_input_port_id: None,
        midi_input_channel: None,
    });
    channels.push(NativeMixerChannel {
        name: "Output".into(),
        color: String::new(),
        id: "benchmark-output".into(),
        kind: "output".into(),
        system_role: None,
        gain_db: 0.0,
        pan: 0.0,
        muted: false,
        soloed: false,
        output_index: None,
        output_bus: None,
        record_armed: false,
        input_monitoring: false,
        input_source: None,
        input_channels: Vec::new(),
        hardware_output_channels: vec![1, 2],
        midi_input_port_id: None,
        midi_input_channel: None,
    });

    let sends = (0..spec.sends)
        .map(|index| NativeMixerSend {
            id: format!("benchmark-send-{index}"),
            source_index: (index % spec.tracks) as u32,
            target_output_index: None,
            target_bus: Some(((index + 1) % spec.buses + 1) as u32),
            enabled: true,
            tap: if index % 4 == 0 {
                LiveMixerSendTap::Pre
            } else {
                LiveMixerSendTap::Post
            },
            level_db: -12.0,
        })
        .collect();

    let plugins = processors
        .iter()
        .take(spec.plugins)
        .enumerate()
        .map(|(index, (instance_id, processor))| NativePluginInstance {
            instance_id: instance_id.clone(),
            channel_index: (index % spec.tracks) as u32,
            role: "insert".into(),
            slot_order: (index / spec.tracks) as u32,
            audio_mode: PluginAudioMode::Stereo,
            enabled: true,
            aux_input_buses: Vec::new(),
            latency_samples: 0,
            tail_samples: Some(0),
            processor: Some(processor.clone()),
        })
        .collect();

    NativeMixerGraph {
        generation: 1,
        sample_rate: BENCHMARK_SAMPLE_RATE,
        latency_policy: NativeLatencyPolicy::Normal,
        channels,
        sends,
        clips: Vec::new(),
        plugins,
        midi_clips: Vec::new(),
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

fn benchmark_runtime(
    spec: AudioBenchmarkSpec,
    processors: &[(String, Vst3ProcessorHandle)],
) -> std::result::Result<NativeMixerRuntime, String> {
    let transport = Arc::new(TransportShared {
        state: Arc::new(AtomicU32::new(TRANSPORT_STOPPED)),
        position_frames: Arc::new(AtomicU64::new(0)),
        position_ticks: Arc::new(AtomicU64::new(0)),
        sample_rate: AtomicU32::new(BENCHMARK_SAMPLE_RATE),
        effective_bpm_bits: AtomicU64::new(f64::NAN.to_bits()),
        clock_source: AtomicU32::new(0),
        waiting_for: AtomicU32::new(0),
        loop_enabled: AtomicBool::new(false),
        loop_has_range: AtomicBool::new(false),
        loop_start_tick: AtomicU64::new(0),
        loop_end_tick: AtomicU64::new(0),
    });
    build_mixer_runtime(
        benchmark_graph(spec, processors),
        1,
        transport,
        Arc::new(InputPeakBank::new()),
    )
    .map_err(|error| error.to_string())
}

fn measure_audio_benchmark_spec(
    spec: AudioBenchmarkSpec,
    processors: &[(String, Vst3ProcessorHandle)],
    target_time: Duration,
    max_virtual_frames: usize,
) -> std::result::Result<AudioBenchmarkScenario, String> {
    let mut runtime = benchmark_runtime(spec, processors)?;
    let mut inputs = vec![[0.0; MAX_INPUT_CHANNELS]; spec.block_frames];
    let mut outputs = vec![[0.0; MAX_OUTPUT_CHANNELS]; spec.block_frames];
    for (index, frame) in inputs.iter_mut().enumerate() {
        let sample = index as f32 / spec.block_frames as f32 * 0.05 - 0.025;
        frame[0] = sample;
        frame[1] = -sample * 0.75;
    }

    for _ in 0..8 {
        black_box(runtime.render_block(black_box(&inputs), black_box(&mut outputs), None));
    }

    let started = Instant::now();
    let mut rendered_frames = 0_usize;
    let mut rendered_blocks = 0_usize;
    let mut block_times_ms =
        Vec::with_capacity(max_virtual_frames.div_ceil(spec.block_frames).min(16_384));
    while rendered_frames < max_virtual_frames {
        let block_started = Instant::now();
        black_box(runtime.render_block(black_box(&inputs), black_box(&mut outputs), None));
        block_times_ms.push(block_started.elapsed().as_secs_f64() * 1_000.0);
        rendered_frames += spec.block_frames;
        rendered_blocks += 1;
        if started.elapsed() >= target_time {
            break;
        }
    }

    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let audio_duration_ms = rendered_frames as f64 / f64::from(BENCHMARK_SAMPLE_RATE) * 1_000.0;
    let average_block_ms = elapsed_ms / rendered_blocks.max(1) as f64;
    let buffer_budget_ms = spec.block_frames as f64 / f64::from(BENCHMARK_SAMPLE_RATE) * 1_000.0;
    block_times_ms.sort_by(f64::total_cmp);
    let p95_block_ms = percentile(&block_times_ms, 0.95);
    let p99_block_ms = percentile(&block_times_ms, 0.99);
    let max_block_ms = block_times_ms.last().copied().unwrap_or_default();
    let deadline_misses = block_times_ms
        .iter()
        .filter(|block_ms| **block_ms > buffer_budget_ms)
        .count() as u32;

    Ok(AudioBenchmarkScenario {
        id: spec.id.into(),
        label: spec.label.into(),
        description: spec.description.into(),
        sample_rate: BENCHMARK_SAMPLE_RATE,
        block_size: spec.block_frames as u32,
        tracks: spec.tracks as u32,
        buses: spec.buses as u32,
        sends: spec.sends as u32,
        plugins: spec.plugins as u32,
        elapsed_ms,
        audio_duration_ms,
        average_block_ms,
        p95_block_ms,
        p99_block_ms,
        max_block_ms,
        buffer_budget_ms,
        p99_deadline_utilization_percent: p99_block_ms / buffer_budget_ms * 100.0,
        deadline_misses,
        measured_blocks: rendered_blocks as u32,
        realtime_factor: audio_duration_ms / elapsed_ms.max(f64::EPSILON),
    })
}

pub fn run_audio_benchmark(
    processors: Vec<(String, Vst3ProcessorHandle)>,
) -> std::result::Result<AudioBenchmarkReport, String> {
    let required_plugins = AUDIO_BENCHMARK_SPECS
        .iter()
        .map(|spec| spec.plugins)
        .max()
        .unwrap_or_default();
    if processors.len() < required_plugins {
        return Err(format!(
            "audio benchmark requires {required_plugins} VST3 instances, received {}",
            processors.len()
        ));
    }

    let started = Instant::now();
    let scenarios = AUDIO_BENCHMARK_SPECS
        .into_iter()
        .map(|spec| {
            measure_audio_benchmark_spec(
                spec,
                &processors,
                TARGET_MEASUREMENT_TIME,
                MAX_VIRTUAL_FRAMES,
            )
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let overall_realtime_factor = scenarios
        .iter()
        .map(|scenario| scenario.realtime_factor)
        .fold(f64::INFINITY, f64::min);
    let worst_p99_deadline_utilization_percent = scenarios
        .iter()
        .map(|scenario| scenario.p99_deadline_utilization_percent)
        .fold(0.0, f64::max);

    Ok(AudioBenchmarkReport {
        duration_ms: started.elapsed().as_secs_f64() * 1_000.0,
        overall_realtime_factor,
        worst_p99_deadline_utilization_percent,
        scenarios,
    })
}

#[cfg(test)]
#[allow(clippy::wildcard_imports)]
mod benchmark_tests {
    use super::*;

    #[test]
    fn audio_benchmark_specs_scale_vst3_load_with_session_size() {
        assert_eq!(AUDIO_BENCHMARK_SPECS.map(|spec| spec.plugins), [8, 32, 64]);
        assert!(
            AUDIO_BENCHMARK_SPECS
                .windows(2)
                .all(|pair| pair[0].tracks < pair[1].tracks && pair[0].plugins < pair[1].plugins)
        );
    }

    #[test]
    fn audio_benchmark_rejects_an_incomplete_plugin_pool() {
        let error = run_audio_benchmark(Vec::new()).expect_err("missing VST3 pool must fail");
        assert!(error.contains("requires 64 VST3 instances"));
    }

    #[test]
    fn percentile_uses_nearest_rank_in_a_sorted_sample() {
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 0.95), 4.0);
        assert_eq!(percentile(&[], 0.99), 0.0);
    }
}
