use super::{Arc, ArenaReceiver, BinaryPayload, Mutex, ResolvedBlob};

pub(in crate::runtime) enum DeferredBinary {
    Inline(Vec<u8>),
    Shared(ResolvedBlob),
}

impl DeferredBinary {
    pub(in crate::runtime) fn as_slice(&self) -> &[u8] {
        match self {
            Self::Inline(bytes) => bytes,
            Self::Shared(blob) => blob.as_slice(),
        }
    }
}

pub(in crate::runtime) fn resolve_deferred_binary(
    payload: BinaryPayload,
    arena: &Arc<Mutex<ArenaReceiver>>,
) -> Result<DeferredBinary, String> {
    match payload {
        BinaryPayload::Inline { bytes } => Ok(DeferredBinary::Inline(bytes)),
        BinaryPayload::Shared { reference } => arena
            .lock()
            .map_err(|_| "request arena is poisoned".to_owned())?
            .acquire(reference)
            .map(DeferredBinary::Shared)
            .map_err(|error| error.to_string()),
        BinaryPayload::Attachment { .. } => {
            Err("VST3 state still references a Node attachment".to_owned())
        }
    }
}
