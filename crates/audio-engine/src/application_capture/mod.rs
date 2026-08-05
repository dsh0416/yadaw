//! Platform application-audio capture.
//!
//! The control plane owns this manager.  Captured samples are intentionally
//! exposed through a bounded producer/consumer pair so the platform callback
//! never crosses the Electron/N-API boundary.

use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Split},
};
use std::sync::{
    Arc, OnceLock, RwLock,
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
};

#[cfg(not(target_os = "windows"))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(not(target_os = "windows"))]
use unsupported::UnsupportedApplicationCaptureBackend;
#[cfg(target_os = "windows")]
use windows::WindowsApplicationCaptureBackend;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationCaptureLogicalTarget {
    pub platform: String,
    pub executable_path: String,
    pub executable_name: String,
    pub include_process_tree: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationCaptureTargetDescriptor {
    pub runtime_id: String,
    pub process_id: u32,
    pub display_name: String,
    pub executable_path: String,
    pub logical_target: ApplicationCaptureLogicalTarget,
    pub channel_count: u32,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationCaptureSnapshot {
    pub runtime_id: String,
    pub process_id: Option<u32>,
    pub display_name: String,
    pub executable_path: String,
    pub logical_target: ApplicationCaptureLogicalTarget,
    pub channel_count: u32,
    pub status: String,
    pub dropout_frames: u64,
    pub overflow_frames: u64,
    pub underflow_frames: u64,
}

pub trait ApplicationCaptureBackend: Send + Sync {
    fn enumerate_targets(&self) -> Vec<ApplicationCaptureTargetDescriptor>;
    fn snapshot(&self) -> Vec<ApplicationCaptureSnapshot>;
    fn prepare_capture(
        &self,
        target: &ApplicationCaptureLogicalTarget,
        session_sample_rate: u32,
    ) -> Result<PreparedApplicationCapture, String>;
}

pub type ApplicationCaptureFrame = [f32; 2];

pub(crate) const APPLICATION_CAPTURE_STATUS_INACTIVE: u32 = 0;

pub struct ApplicationCaptureCounters {
    pub dropout_frames: AtomicU64,
    pub overflow_frames: AtomicU64,
    pub underflow_frames: AtomicU64,
}

impl ApplicationCaptureCounters {
    #[must_use]
    pub fn new() -> Self {
        Self {
            dropout_frames: AtomicU64::new(0),
            overflow_frames: AtomicU64::new(0),
            underflow_frames: AtomicU64::new(0),
        }
    }
}

impl Default for ApplicationCaptureCounters {
    fn default() -> Self {
        Self::new()
    }
}

pub struct PreparedApplicationCapture {
    pub source_sample_rate: u32,
    pub source_channel_count: u32,
    pub consumer: HeapCons<ApplicationCaptureFrame>,
    pub active: Arc<AtomicBool>,
    pub stop: Arc<AtomicBool>,
    pub counters: Arc<ApplicationCaptureCounters>,
    pub status: Arc<AtomicU32>,
}

impl PreparedApplicationCapture {
    #[must_use]
    pub fn new(
        source_sample_rate: u32,
        source_channel_count: u32,
    ) -> (Self, HeapProd<ApplicationCaptureFrame>) {
        let (producer, consumer) =
            HeapRb::<ApplicationCaptureFrame>::new(source_sample_rate.max(1) as usize * 2).split();
        let active = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let counters = Arc::new(ApplicationCaptureCounters::new());
        let status = Arc::new(AtomicU32::new(APPLICATION_CAPTURE_STATUS_INACTIVE));
        (
            Self {
                source_sample_rate,
                source_channel_count: source_channel_count.clamp(1, 2),
                consumer,
                active,
                stop,
                counters,
                status,
            },
            producer,
        )
    }

    pub fn activate(&self) {
        self.active.store(true, Ordering::Release);
    }
    pub fn abort(&self) {
        self.stop.store(true, Ordering::Release);
    }

    pub fn pop_frame(&mut self) -> Option<ApplicationCaptureFrame> {
        self.consumer.try_pop()
    }
}

impl Drop for PreparedApplicationCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[derive(Clone)]
pub struct ApplicationCaptureManager {
    backend: Arc<dyn ApplicationCaptureBackend>,
}

static GLOBAL_MANAGER: OnceLock<ApplicationCaptureManager> = OnceLock::new();

#[must_use]
pub fn global_manager() -> &'static ApplicationCaptureManager {
    GLOBAL_MANAGER.get_or_init(ApplicationCaptureManager::new)
}

impl ApplicationCaptureManager {
    #[must_use]
    pub fn new() -> Self {
        #[cfg(target_os = "windows")]
        let backend = WindowsApplicationCaptureBackend::new();
        #[cfg(not(target_os = "windows"))]
        let backend = UnsupportedApplicationCaptureBackend::new();
        Self {
            backend: Arc::new(backend),
        }
    }

    #[must_use]
    pub fn enumerate_targets(&self) -> Vec<ApplicationCaptureTargetDescriptor> {
        self.backend.enumerate_targets()
    }

    #[must_use]
    pub fn snapshot(&self) -> Vec<ApplicationCaptureSnapshot> {
        self.backend.snapshot()
    }

    pub fn prepare_capture(
        &self,
        target: &ApplicationCaptureLogicalTarget,
        session_sample_rate: u32,
    ) -> Result<PreparedApplicationCapture, String> {
        self.backend.prepare_capture(target, session_sample_rate)
    }
}

impl Default for ApplicationCaptureManager {
    fn default() -> Self {
        Self::new()
    }
}

#[allow(dead_code)]
fn _assert_sync() {
    let _: Option<RwLock<()>> = None;
}

#[cfg(test)]
mod tests {
    use super::PreparedApplicationCapture;
    use ringbuf::traits::Producer;

    #[test]
    fn prepared_route_is_bounded_and_starts_silent() {
        let (mut route, mut producer) = PreparedApplicationCapture::new(48_000, 4);
        assert_eq!(route.source_channel_count, 2);
        route.activate();
        assert!(route.pop_frame().is_none());
        assert!(producer.try_push([0.25, -0.25]).is_ok());
        assert_eq!(route.pop_frame(), Some([0.25, -0.25]));
        route.abort();
    }
}
