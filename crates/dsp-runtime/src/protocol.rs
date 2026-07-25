use std::{
    error::Error,
    fmt,
    io::{self, Read, Write},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlRequest {
    pub version: u16,
    pub request_id: u64,
    pub command: ControlCommand,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlCommand {
    Ping,
    Shutdown,
    LoadGraph {
        revision: u64,
    },
    LoadPlugin {
        instance_id: String,
        module_path: String,
        class_id: String,
        sample_rate: f64,
        #[serde(with = "serde_bytes")]
        component_state: Vec<u8>,
        #[serde(with = "serde_bytes")]
        controller_state: Vec<u8>,
    },
    UnloadPlugin {
        instance_id: String,
    },
    PluginParameters {
        instance_id: String,
    },
    SetPluginParameter {
        instance_id: String,
        parameter_id: u32,
        normalized: f64,
        gesture: ParameterGesture,
    },
    SavePluginState {
        instance_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParameterGesture {
    Begin,
    Perform,
    End,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginParameter {
    pub id: u32,
    pub title: String,
    pub units: String,
    pub step_count: i32,
    pub default_normalized: f64,
    pub normalized: f64,
    pub flags: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlResponse {
    pub version: u16,
    pub request_id: u64,
    pub result: ControlResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlResult {
    Pong,
    Accepted,
    PluginLoaded {
        latency_samples: u32,
        tail_samples: Option<u32>,
    },
    PluginParameters {
        parameters: Vec<PluginParameter>,
    },
    PluginState {
        #[serde(with = "serde_bytes")]
        component_state: Vec<u8>,
        #[serde(with = "serde_bytes")]
        controller_state: Vec<u8>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    Encode(rmp_serde::encode::Error),
    Decode(rmp_serde::decode::Error),
    MessageTooLarge(usize),
    VersionMismatch(u16),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "helper protocol I/O failed: {error}"),
            Self::Encode(error) => write!(formatter, "helper message encoding failed: {error}"),
            Self::Decode(error) => write!(formatter, "helper message decoding failed: {error}"),
            Self::MessageTooLarge(size) => {
                write!(formatter, "helper message exceeds 64 MiB: {size}")
            }
            Self::VersionMismatch(version) => {
                write!(formatter, "unsupported helper protocol version {version}")
            }
        }
    }
}

impl Error for ProtocolError {}

impl From<io::Error> for ProtocolError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

pub fn write_message<T: Serialize>(
    writer: &mut impl Write,
    value: &T,
) -> Result<(), ProtocolError> {
    let payload = rmp_serde::to_vec_named(value).map_err(ProtocolError::Encode)?;
    if payload.len() > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::MessageTooLarge(payload.len()));
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

pub fn read_message<T: DeserializeOwned>(reader: &mut impl Read) -> Result<T, ProtocolError> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::MessageTooLarge(length));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload)?;
    rmp_serde::from_slice(&payload).map_err(ProtocolError::Decode)
}

pub fn validate_version(version: u16) -> Result<(), ProtocolError> {
    if version == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(ProtocolError::VersionMismatch(version))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messagepack_frame_round_trips() {
        let request = ControlRequest {
            version: PROTOCOL_VERSION,
            request_id: 42,
            command: ControlCommand::LoadGraph { revision: 7 },
        };
        let mut bytes = Vec::new();
        write_message(&mut bytes, &request).unwrap();
        assert_eq!(
            read_message::<ControlRequest>(&mut bytes.as_slice()).unwrap(),
            request
        );
    }

    #[test]
    fn rejects_oversized_frame_before_allocating() {
        let mut bytes = ((MAX_MESSAGE_BYTES as u32) + 1).to_be_bytes().to_vec();
        bytes.extend_from_slice(&[0; 4]);
        assert!(matches!(
            read_message::<ControlRequest>(&mut bytes.as_slice()),
            Err(ProtocolError::MessageTooLarge(_))
        ));
    }
}
