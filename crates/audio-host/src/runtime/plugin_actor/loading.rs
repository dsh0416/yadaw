use super::BinaryPayload;

pub(in crate::runtime) struct DeferredBinary(Vec<u8>);

impl DeferredBinary {
    pub(in crate::runtime) fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

pub(in crate::runtime) fn resolve_deferred_binary(
    payload: BinaryPayload,
) -> Result<DeferredBinary, String> {
    match payload {
        BinaryPayload::Inline { bytes } => Ok(DeferredBinary(bytes)),
        BinaryPayload::Shared { .. } => {
            Err("VST3 state references removed shared memory".to_owned())
        }
        BinaryPayload::Attachment { .. } => {
            Err("VST3 state still references a Node attachment".to_owned())
        }
    }
}
