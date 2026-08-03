use super::*;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("shared-memory mapping failed: {0}")]
    SharedMemory(#[from] heron_shared_memory::SharedMemoryError),
    #[error("could not encode transport packet: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("could not decode transport packet: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
    #[error("transport packet exceeds 64 MiB")]
    MessageTooLarge,
    #[error("shared-memory lease capacity is exhausted")]
    LeaseCapacity,
    #[error("shared-memory lease identifier is already active")]
    DuplicateLease,
    #[error("shared blob references an unknown region")]
    UnknownRegion,
    #[error("shared blob belongs to a stale session or region generation")]
    StaleRegion,
    #[error("shared blob allocation is stale or not ready")]
    StaleAllocation,
    #[error("shared blob range is invalid")]
    InvalidRange,
    #[error("shared page has an invalid layout")]
    InvalidSharedLayout,
    #[error("shared page capacity is invalid")]
    InvalidCapacity,
    #[error("transport invariant violated: {0}")]
    Invariant(&'static str),
}
