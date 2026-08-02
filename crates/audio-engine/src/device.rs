use crate::mock;
use crate::{HostError as Error, HostResult as Result, Status};
use cpal::{
    Host, SupportedBufferSize, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait},
};

const KNOWN_BACKENDS: [(&str, &str); 4] = [
    ("wasapi", "WASAPI"),
    ("asio", "ASIO"),
    ("coreaudio", "CoreAudio"),
    ("alsa", "ALSA"),
];

pub struct NativeAudioBackend {
    pub id: String,
    pub label: String,
    pub available: bool,
}

pub struct NativeAudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub default_sample_rate: Option<u32>,
    pub min_buffer_size: Option<u32>,
    pub max_buffer_size: Option<u32>,
    pub channel_count: Option<u32>,
}

pub struct NativeAudioDeviceList {
    pub inputs: Vec<NativeAudioDevice>,
    pub outputs: Vec<NativeAudioDevice>,
}

fn cpal_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn stream_capabilities(
    config: std::result::Result<SupportedStreamConfig, cpal::Error>,
) -> (Option<u32>, Option<u32>, Option<u32>, Option<u32>) {
    let Ok(config) = config else {
        return (None, None, None, None);
    };
    let sample_rate = Some(config.sample_rate());
    let channel_count = Some(u32::from(config.channels()));
    match config.buffer_size() {
        SupportedBufferSize::Range { min, max } => {
            (sample_rate, Some(*min), Some(*max), channel_count)
        }
        SupportedBufferSize::Unknown => (sample_rate, None, None, channel_count),
    }
}

pub fn list_audio_backends() -> Vec<NativeAudioBackend> {
    let available_hosts = cpal::available_hosts();

    let mut backends = KNOWN_BACKENDS
        .iter()
        .map(|(id, label)| NativeAudioBackend {
            id: (*id).to_owned(),
            label: (*label).to_owned(),
            available: available_hosts
                .iter()
                .any(|host_id| host_id.to_string().eq_ignore_ascii_case(id)),
        })
        .collect::<Vec<_>>();
    // The mock backend is a cpal custom host, which cpal deliberately keeps out
    // of `available_hosts`. It ships in every build and needs no driver, so it
    // is always selectable and is listed last as the fallback for machines with
    // no usable audio hardware.
    backends.push(NativeAudioBackend {
        id: mock::BACKEND_ID.to_owned(),
        label: mock::BACKEND_LABEL.to_owned(),
        available: true,
    });
    backends
}

/// Resolves a backend identifier to the cpal host that serves it.
pub fn host_for_backend(backend: &str) -> Result<Host> {
    if mock::is_mock_backend(backend) {
        return Ok(mock::host());
    }

    let host_id = cpal::available_hosts()
        .into_iter()
        .find(|host_id| host_id.to_string().eq_ignore_ascii_case(backend))
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("cpal backend '{backend}' is not available in this build"),
            )
        })?;

    cpal::host_from_id(host_id).map_err(|error| cpal_error("failed to initialize cpal host", error))
}

pub fn list_audio_devices(backend: String) -> Result<NativeAudioDeviceList> {
    let host = host_for_backend(&backend)?;
    let default_input_id = host
        .default_input_device()
        .and_then(|device| device.id().ok());
    let default_output_id = host
        .default_output_device()
        .and_then(|device| device.id().ok());

    let inputs = host
        .input_devices()
        .map_err(|error| cpal_error("failed to enumerate cpal input devices", error))?
        .map(|device| {
            let id = device
                .id()
                .map_err(|error| cpal_error("failed to read cpal input device id", error))?;
            let is_default = default_input_id.as_ref() == Some(&id);
            let (default_sample_rate, min_buffer_size, max_buffer_size, channel_count) =
                stream_capabilities(device.default_input_config());
            Ok(NativeAudioDevice {
                id: id.to_string(),
                name: device.to_string(),
                is_default,
                default_sample_rate,
                min_buffer_size,
                max_buffer_size,
                channel_count,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let outputs = host
        .output_devices()
        .map_err(|error| cpal_error("failed to enumerate cpal output devices", error))?
        .map(|device| {
            let id = device
                .id()
                .map_err(|error| cpal_error("failed to read cpal output device id", error))?;
            let is_default = default_output_id.as_ref() == Some(&id);
            let (default_sample_rate, min_buffer_size, max_buffer_size, channel_count) =
                stream_capabilities(device.default_output_config());
            Ok(NativeAudioDevice {
                id: id.to_string(),
                name: device.to_string(),
                is_default,
                default_sample_rate,
                min_buffer_size,
                max_buffer_size,
                channel_count,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(NativeAudioDeviceList { inputs, outputs })
}
