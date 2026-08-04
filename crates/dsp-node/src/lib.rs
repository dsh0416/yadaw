use heron_dsp_core::apply_gain;
use napi::{Error, Result, Status};
use napi_derive::napi;

mod audio_host;
mod benchmark;
mod midi;
mod midi_journal;
mod recording;

#[cfg(feature = "bench-internals")]
#[doc(hidden)]
pub mod bench_support {
    pub use crate::recording::bench_support::{
        TapHarness, WaveformHarness, finalize_fixture, write_float_fixture, write_recording_session,
    };
}

pub use audio_host::{
    AudioHostRuntime, NativeHostResponse, ParameterEnqueueRequest, ParameterEnqueueResult,
};
pub use benchmark::run_audio_benchmark;
pub use midi::parse_midi_file;
pub use midi_journal::recover_midi_journal_take;
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
