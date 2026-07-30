use std::{
    error::Error,
    fmt,
    io::{self, Read, Write},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const NATIVE_BUILD_FINGERPRINT: &str = env!("YADAW_NATIVE_BUILD_FINGERPRINT");
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub const INLINE_BLOB_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SharedBlobRef {
    pub session_epoch: u64,
    pub region_id: u32,
    pub region_generation: u64,
    pub slot: u16,
    pub allocation_generation: u64,
    pub offset: u64,
    pub length: u64,
    pub lease_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "storage", rename_all = "kebab-case")]
pub enum BinaryPayload {
    Inline {
        #[serde(with = "serde_bytes")]
        bytes: Vec<u8>,
    },
    Shared {
        reference: SharedBlobRef,
    },
    Attachment {
        index: u16,
        offset: u64,
        length: u64,
    },
}

impl Default for BinaryPayload {
    fn default() -> Self {
        Self::inline(Vec::new())
    }
}

impl BinaryPayload {
    #[must_use]
    pub fn inline(bytes: Vec<u8>) -> Self {
        Self::Inline { bytes }
    }

    #[must_use]
    pub fn as_inline(&self) -> Option<&[u8]> {
        match self {
            Self::Inline { bytes } => Some(bytes),
            Self::Shared { .. } | Self::Attachment { .. } => None,
        }
    }
}

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    Encode(rmp_serde::encode::Error),
    Decode(rmp_serde::decode::Error),
    MessageTooLarge(usize),
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
