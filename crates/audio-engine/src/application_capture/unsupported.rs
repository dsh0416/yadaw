use super::{
    APPLICATION_CAPTURE_STATUS_UNSUPPORTED, ApplicationCaptureBackend, ApplicationCaptureError,
    ApplicationCaptureLogicalTarget, ApplicationCaptureRegistry, ApplicationCaptureSnapshot,
    ApplicationCaptureTargetDescriptor, PreparedApplicationCapture,
};
use std::sync::Arc;

pub(super) struct UnsupportedApplicationCaptureBackend {
    registry: Arc<ApplicationCaptureRegistry>,
}

impl UnsupportedApplicationCaptureBackend {
    pub(super) fn new() -> Self {
        Self {
            registry: Arc::new(ApplicationCaptureRegistry::default()),
        }
    }
}

impl ApplicationCaptureBackend for UnsupportedApplicationCaptureBackend {
    fn enumerate_targets(&self) -> Vec<ApplicationCaptureTargetDescriptor> {
        Vec::new()
    }

    fn snapshot(&self) -> Vec<ApplicationCaptureSnapshot> {
        self.registry.snapshot()
    }

    fn prepare_capture(
        &self,
        target: &ApplicationCaptureLogicalTarget,
        session_sample_rate: u32,
    ) -> Result<PreparedApplicationCapture, ApplicationCaptureError> {
        let descriptor = ApplicationCaptureTargetDescriptor {
            runtime_id: format!("unsupported:{}:{}", target.platform, target.executable_path),
            process_id: 0,
            display_name: target.executable_name.clone(),
            executable_path: target.executable_path.clone(),
            logical_target: target.clone(),
            channel_count: 2,
            status: "unsupported".to_owned(),
        };
        let prepared = PreparedApplicationCapture::silent(
            descriptor,
            session_sample_rate,
            APPLICATION_CAPTURE_STATUS_UNSUPPORTED,
        )?;
        self.registry.register(&prepared.state);
        Ok(prepared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_platform_prepares_a_queryable_silent_route() {
        let backend = UnsupportedApplicationCaptureBackend::new();
        let target = ApplicationCaptureLogicalTarget {
            platform: "windows".to_owned(),
            bundle_identifier: None,
            executable_path: "C:/Program Files/Player/player.exe".to_owned(),
            executable_name: "player.exe".to_owned(),
            include_process_tree: true,
        };

        let _prepared = backend
            .prepare_capture(&target, 48_000)
            .expect("unsupported hosts retain a silent application route");
        let snapshots = backend.snapshot();

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].status, "unsupported");
        assert_eq!(snapshots[0].logical_target, target);
    }
}
