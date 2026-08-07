use super::{
    ApplicationCaptureBackend, ApplicationCaptureError, ApplicationCaptureLogicalTarget,
    ApplicationCaptureSnapshot, ApplicationCaptureTargetDescriptor, PreparedApplicationCapture,
};

pub(super) struct UnsupportedApplicationCaptureBackend;

impl UnsupportedApplicationCaptureBackend {
    pub(super) fn new() -> Self {
        Self
    }
}

impl ApplicationCaptureBackend for UnsupportedApplicationCaptureBackend {
    fn enumerate_targets(&self) -> Vec<ApplicationCaptureTargetDescriptor> {
        Vec::new()
    }

    fn snapshot(&self) -> Vec<ApplicationCaptureSnapshot> {
        Vec::new()
    }

    fn prepare_capture(
        &self,
        _target: &ApplicationCaptureLogicalTarget,
        _session_sample_rate: u32,
    ) -> Result<PreparedApplicationCapture, ApplicationCaptureError> {
        Err(ApplicationCaptureError::Platform(
            "application capture is unsupported on this platform".to_owned(),
        ))
    }
}
