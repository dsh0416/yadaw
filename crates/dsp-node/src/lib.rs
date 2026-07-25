use napi::{Error, Result, Status};
use napi_derive::napi;
use yadaw_dsp_core::apply_gain;

mod audio;
mod audio_engine;
mod benchmark;
mod recording;

#[cfg(feature = "bench-internals")]
#[doc(hidden)]
pub mod bench_support {
    pub use crate::audio_engine::bench_support::{
        GraphSwapHarness, ParameterQueueHarness, RenderHarness, RenderScenario, ResamplerHarness,
        StreamingHarness, decode_clip,
    };
    pub use crate::recording::bench_support::{
        TapHarness, WaveformHarness, finalize_fixture, write_float_fixture, write_recording_session,
    };
}

pub use audio::{list_audio_backends, list_audio_devices};
pub use audio_engine::{
    audio_engine_snapshot, load_mixer_graph, mixer_snapshot, preview_mixer_parameter,
    recording_waveform_snapshot, start_audio_engine, start_recording, stop_audio_engine,
    stop_recording, transport_command, transport_snapshot,
};
pub use benchmark::run_audio_benchmark;
pub use recording::{
    analyze_waveform, finalize_recording, repair_recording_header,
    write_deterministic_test_recording,
};

#[napi(object)]
pub struct NativeEngineInfo {
    pub backend: String,
    pub version: String,
    pub node_api: u32,
}

#[napi(object)]
pub struct ProcessGainResult {
    pub samples: Vec<f64>,
    pub peak: f64,
}

#[napi]
pub fn engine_info() -> NativeEngineInfo {
    NativeEngineInfo {
        backend: "rust+napi-rs".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        node_api: 8,
    }
}

#[napi]
pub fn process_gain(samples: Vec<f64>, gain: f64) -> Result<ProcessGainResult> {
    if samples.len() > 1_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "offline preview is limited to 1,000,000 samples",
        ));
    }

    let mut samples: Vec<f32> = samples.into_iter().map(|sample| sample as f32).collect();
    let stats = apply_gain(&mut samples, gain as f32)
        .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;

    Ok(ProcessGainResult {
        samples: samples.into_iter().map(f64::from).collect(),
        peak: f64::from(stats.peak),
    })
}
