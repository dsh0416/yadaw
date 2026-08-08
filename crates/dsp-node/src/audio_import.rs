use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::Path,
};

use bwavfile::WaveWriter;
use napi::{Error, Result, Status, Task};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use symphonia::core::{
    audio::AudioSpec,
    codecs::audio::AudioDecoderOptions,
    errors::Error as SymphoniaError,
    formats::{FormatOptions, TrackType, probe::Hint},
    io::MediaSourceStream,
    meta::MetadataOptions,
};
use symphonia::default::{get_codecs, get_probe};

use crate::recording::{
    NativeWaveformLevel, analyze_waveform_path, broadcast_metadata, float_format, recording_error,
};

#[napi(object)]
pub struct NativeAudioImportConfig {
    pub input_path: String,
    pub output_path: String,
    pub asset_id: String,
    pub originator: String,
    pub origination_date: String,
    pub origination_time: String,
}

#[napi(object)]
pub struct NativeImportedAudio {
    pub path: String,
    pub content_hash: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_depth: String,
    pub frame_count: i64,
    pub time_reference: i64,
    pub waveform_levels: Vec<NativeWaveformLevel>,
}

fn import_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::InvalidArg, format!("{context}: {error}"))
}

fn source_hash(path: &str) -> Result<String> {
    let mut file =
        File::open(path).map_err(|error| import_error("failed to open import", error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| import_error("failed to hash import", error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn decode_audio(path: &str) -> Result<(AudioSpec, Vec<f32>)> {
    let source = File::open(path).map_err(|error| import_error("failed to open import", error))?;
    let stream = MediaSourceStream::new(Box::new(source), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = Path::new(path).extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let mut format = get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| import_error("unsupported or invalid audio file", error))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| Error::new(Status::InvalidArg, "audio file has no default track"))?;
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .ok_or_else(|| Error::new(Status::InvalidArg, "audio codec parameters are missing"))?;
    let mut decoder = get_codecs()
        .make_audio_decoder(codec_params, &AudioDecoderOptions::default())
        .map_err(|error| import_error("unsupported audio codec", error))?;
    let mut expected_spec: Option<AudioSpec> = None;
    let mut samples = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err(Error::new(
                    Status::InvalidArg,
                    "audio stream changes format during import",
                ));
            }
            Err(error) => return Err(import_error("failed to read audio packet", error)),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(error)) => {
                return Err(import_error("failed to decode audio packet", error));
            }
            Err(error) => return Err(import_error("failed to decode audio packet", error)),
        };
        let spec = decoded.spec().clone();
        let channels = spec.channels().count();
        if !(1..=2).contains(&channels) {
            return Err(Error::new(
                Status::InvalidArg,
                format!("only mono and stereo imports are supported; file has {channels} channels"),
            ));
        }
        if let Some(expected) = expected_spec.as_ref() {
            if expected != &spec {
                return Err(Error::new(
                    Status::InvalidArg,
                    "audio stream changes sample rate or channels during import",
                ));
            }
        } else {
            expected_spec = Some(spec);
        }
        let mut converted = Vec::<f32>::new();
        decoded.copy_to_vec_interleaved(&mut converted);
        samples.extend_from_slice(&converted);
    }
    let spec = expected_spec.ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "audio file does not contain decodable samples",
        )
    })?;
    Ok((spec, samples))
}

fn transcode(config: &NativeAudioImportConfig) -> Result<NativeImportedAudio> {
    let content_hash = source_hash(&config.input_path)?;
    let (spec, samples) = decode_audio(&config.input_path)?;
    let channels = spec.channels().count();
    let format = float_format(spec.rate(), channels);
    let mut writer = WaveWriter::create(&config.output_path, format)
        .map_err(|error| recording_error("failed to create imported BWF", error))?;
    writer
        .write_broadcast_metadata(&broadcast_metadata(
            &config.asset_id,
            &config.originator,
            &config.origination_date,
            &config.origination_time,
            0,
            format!(
                "A=PCM,F={},W=32,M={} channel,T=Heron media import\r\n",
                spec.rate(),
                channels
            ),
        ))
        .map_err(|error| recording_error("failed to write imported BWF metadata", error))?;
    let mut audio = writer
        .audio_frame_writer()
        .map_err(|error| recording_error("failed to start imported BWF audio", error))?;
    audio
        .write_frames(&samples)
        .map_err(|error| recording_error("failed to write imported BWF", error))?;
    audio
        .end()
        .map_err(|error| recording_error("failed to finalize imported BWF", error))?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&config.output_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| recording_error("failed to flush imported BWF", error))?;
    let analyzed = analyze_waveform_path(&config.output_path)?;
    Ok(NativeImportedAudio {
        path: config.output_path.clone(),
        content_hash,
        sample_rate: analyzed.sample_rate,
        channels: analyzed.channels,
        bit_depth: "float32".to_owned(),
        frame_count: analyzed.frame_count,
        time_reference: 0,
        waveform_levels: analyzed.waveform_levels,
    })
}

pub struct ImportAudioFileTask {
    config: NativeAudioImportConfig,
}

#[napi]
impl Task for ImportAudioFileTask {
    type Output = NativeImportedAudio;
    type JsValue = NativeImportedAudio;

    fn compute(&mut self) -> Result<Self::Output> {
        transcode(&self.config)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn import_audio_file(
    config: NativeAudioImportConfig,
) -> napi::bindgen_prelude::AsyncTask<ImportAudioFileTask> {
    napi::bindgen_prelude::AsyncTask::new(ImportAudioFileTask { config })
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, time::SystemTime};

    use super::*;

    fn temporary_file(label: &str, extension: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("time moves forward")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "heron-audio-import-{label}-{}-{nonce}.{extension}",
            std::process::id()
        ))
    }

    fn write_input(path: &Path, channels: usize) {
        let writer = WaveWriter::create(path, float_format(48_000, channels))
            .expect("create import fixture");
        let mut audio = writer.audio_frame_writer().expect("open fixture audio");
        let samples = (0..128 * channels)
            .map(|index| (index as f32 / 128.0).sin() * 0.25)
            .collect::<Vec<_>>();
        audio.write_frames(&samples).expect("write fixture frames");
        audio.end().expect("finalize fixture");
    }

    #[test]
    fn transcode_canonicalizes_audio_and_reports_source_identity() {
        let input = temporary_file("source", "wav");
        let output = temporary_file("canonical", "bwf");
        write_input(&input, 2);
        let expected_hash = source_hash(&input.to_string_lossy()).expect("hash source");

        let imported = transcode(&NativeAudioImportConfig {
            input_path: input.to_string_lossy().into_owned(),
            output_path: output.to_string_lossy().into_owned(),
            asset_id: "asset-1".to_owned(),
            originator: "Heron test".to_owned(),
            origination_date: "2026-08-08".to_owned(),
            origination_time: "12:00:00".to_owned(),
        })
        .expect("transcode audio");

        assert_eq!(imported.path, output.to_string_lossy());
        assert_eq!(imported.content_hash, expected_hash);
        assert_eq!(imported.sample_rate, 48_000);
        assert_eq!(imported.channels, 2);
        assert_eq!(imported.bit_depth, "float32");
        assert_eq!(imported.frame_count, 128);
        assert!(!imported.waveform_levels.is_empty());
        assert!(output.exists());

        fs::remove_file(input).expect("remove input fixture");
        fs::remove_file(output).expect("remove canonical fixture");
    }

    #[test]
    fn decode_audio_rejects_invalid_media_instead_of_importing_empty_audio() {
        let input = temporary_file("invalid", "mp3");
        fs::write(&input, b"not an audio stream").expect("write invalid fixture");

        let error = decode_audio(&input.to_string_lossy()).expect_err("reject invalid audio");

        assert!(
            error
                .to_string()
                .contains("unsupported or invalid audio file")
        );
        fs::remove_file(input).expect("remove invalid fixture");
    }
}
