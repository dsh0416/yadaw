//! Platform application-audio capture.
//!
//! The control plane owns this manager. Captured samples cross into the audio
//! callback through a bounded ring and a fully preallocated adaptive resampler.

use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};
use rubato::{
    Adjustable, Async, FixedAsync, Resampler, SincInterpolationParameters,
    audioadapter_buffers::direct::InterleavedSlice,
};
use std::sync::{
    Arc, OnceLock, RwLock, Weak,
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
};
use thiserror::Error;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
use macos::MacOsApplicationCaptureBackend;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
use unsupported::UnsupportedApplicationCaptureBackend;
#[cfg(target_os = "windows")]
use windows::WindowsApplicationCaptureBackend;

const APPLICATION_CAPTURE_RESAMPLER_FRAMES: usize = 256;
pub(crate) const APPLICATION_CAPTURE_BUFFER_BLOCKS: usize = 8;

pub(crate) const APPLICATION_CAPTURE_STATUS_INACTIVE: u32 = 0;
pub(crate) const APPLICATION_CAPTURE_STATUS_CAPTURING: u32 = 1;
pub(crate) const APPLICATION_CAPTURE_STATUS_NO_STREAM: u32 = 2;
pub(crate) const APPLICATION_CAPTURE_STATUS_TARGET_MISSING: u32 = 3;
pub(crate) const APPLICATION_CAPTURE_STATUS_AMBIGUOUS_TARGET: u32 = 4;
pub(crate) const APPLICATION_CAPTURE_STATUS_TARGET_EXITED: u32 = 5;
pub(crate) const APPLICATION_CAPTURE_STATUS_UNSUPPORTED: u32 = 6;
pub(crate) const APPLICATION_CAPTURE_STATUS_ERROR: u32 = 7;
pub(crate) const APPLICATION_CAPTURE_STATUS_PERMISSION_DENIED: u32 = 8;

#[derive(Debug, Error)]
pub enum ApplicationCaptureError {
    #[error("invalid application capture configuration: {0}")]
    InvalidConfiguration(String),
    #[error("could not start application capture worker: {0}")]
    WorkerStart(#[source] std::io::Error),
    #[error("application capture platform operation failed: {0}")]
    Platform(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationCaptureLogicalTarget {
    pub platform: String,
    pub bundle_identifier: Option<String>,
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
    ) -> Result<PreparedApplicationCapture, ApplicationCaptureError>;
}

pub type ApplicationCaptureFrame = [f32; 2];

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

pub(crate) struct ApplicationCaptureState {
    descriptor: ApplicationCaptureTargetDescriptor,
    pub(crate) active: AtomicBool,
    pub(crate) stop: AtomicBool,
    pub(crate) counters: ApplicationCaptureCounters,
    pub(crate) status: AtomicU32,
}

impl ApplicationCaptureState {
    fn new(descriptor: ApplicationCaptureTargetDescriptor, status: u32) -> Self {
        Self {
            descriptor,
            active: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            counters: ApplicationCaptureCounters::new(),
            status: AtomicU32::new(status),
        }
    }

    fn snapshot(&self) -> ApplicationCaptureSnapshot {
        ApplicationCaptureSnapshot {
            runtime_id: self.descriptor.runtime_id.clone(),
            process_id: (self.descriptor.process_id != 0).then_some(self.descriptor.process_id),
            display_name: self.descriptor.display_name.clone(),
            executable_path: self.descriptor.executable_path.clone(),
            logical_target: self.descriptor.logical_target.clone(),
            channel_count: self.descriptor.channel_count,
            status: application_capture_status_name(self.status.load(Ordering::Acquire)).to_owned(),
            dropout_frames: self.counters.dropout_frames.load(Ordering::Relaxed),
            overflow_frames: self.counters.overflow_frames.load(Ordering::Relaxed),
            underflow_frames: self.counters.underflow_frames.load(Ordering::Relaxed),
        }
    }
}

#[derive(Default)]
pub(crate) struct ApplicationCaptureRegistry {
    captures: RwLock<Vec<Weak<ApplicationCaptureState>>>,
}

impl ApplicationCaptureRegistry {
    pub(crate) fn register(&self, state: &Arc<ApplicationCaptureState>) {
        if let Ok(mut captures) = self.captures.write() {
            captures.retain(|candidate| candidate.strong_count() > 0);
            captures.push(Arc::downgrade(state));
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<ApplicationCaptureSnapshot> {
        let Ok(mut captures) = self.captures.write() else {
            return Vec::new();
        };
        let mut snapshots = Vec::with_capacity(captures.len());
        captures.retain(|candidate| {
            let Some(state) = candidate.upgrade() else {
                return false;
            };
            snapshots.push(state.snapshot());
            true
        });
        snapshots
    }
}

struct StereoAdaptiveReader {
    consumer: HeapCons<ApplicationCaptureFrame>,
    resampler: Async<f32>,
    input_buffer: Vec<f32>,
    output_buffer: Vec<f32>,
    output_cursor: usize,
    output_frames: usize,
    target_fill: usize,
    capacity: usize,
}

impl StereoAdaptiveReader {
    fn new(
        consumer: HeapCons<ApplicationCaptureFrame>,
        source_sample_rate: u32,
        session_sample_rate: u32,
        target_fill: usize,
        capacity: usize,
    ) -> Result<Self, ApplicationCaptureError> {
        if source_sample_rate == 0 || session_sample_rate == 0 {
            return Err(ApplicationCaptureError::InvalidConfiguration(
                "sample rates must be non-zero".to_owned(),
            ));
        }
        let nominal_ratio = f64::from(session_sample_rate) / f64::from(source_sample_rate);
        let resampler = Async::<f32>::new_sinc(
            nominal_ratio,
            1.002,
            &SincInterpolationParameters::default(),
            APPLICATION_CAPTURE_RESAMPLER_FRAMES,
            2,
            FixedAsync::Output,
        )
        .map_err(|error| ApplicationCaptureError::InvalidConfiguration(error.to_string()))?;
        let input_buffer = vec![0.0; resampler.input_frames_max() * 2];
        let output_buffer = vec![0.0; resampler.output_frames_max() * 2];
        Ok(Self {
            consumer,
            resampler,
            input_buffer,
            output_buffer,
            output_cursor: 0,
            output_frames: 0,
            target_fill,
            capacity,
        })
    }

    fn refill(&mut self) -> (usize, bool) {
        let fill_error = self.consumer.occupied_len() as f64 - self.target_fill as f64;
        let normalized_error = fill_error / self.capacity.max(1) as f64;
        let correction = (normalized_error * 0.002).clamp(-0.001, 0.001);
        if self
            .resampler
            .set_resample_ratio_relative(1.0 / (1.0 + correction), true)
            .is_err()
        {
            self.output_frames = 0;
            self.output_cursor = 0;
            self.resampler.reset();
            return (APPLICATION_CAPTURE_RESAMPLER_FRAMES, true);
        }

        let required = self.resampler.input_frames_next();
        let expected_output = self.resampler.output_frames_next();
        self.input_buffer[..required * 2].fill(0.0);
        let mut available = 0;
        while available < required {
            let Some(frame) = self.consumer.try_pop() else {
                break;
            };
            let offset = available * 2;
            self.input_buffer[offset..offset + 2].copy_from_slice(&frame);
            available += 1;
        }
        self.output_buffer[..expected_output * 2].fill(0.0);
        let processed = {
            let Ok(input) = InterleavedSlice::new(&self.input_buffer[..required * 2], 2, required)
            else {
                return (required.saturating_sub(available), true);
            };
            let Ok(mut output) = InterleavedSlice::new_mut(
                &mut self.output_buffer[..expected_output * 2],
                2,
                expected_output,
            ) else {
                return (required.saturating_sub(available), true);
            };
            self.resampler
                .process_into_buffer(&input, &mut output, None)
        };
        match processed {
            Ok((_consumed, produced)) => {
                self.output_cursor = 0;
                self.output_frames = produced;
                (required.saturating_sub(available), available < required)
            }
            Err(_) => {
                self.output_cursor = 0;
                self.output_frames = 0;
                self.resampler.reset();
                (required, true)
            }
        }
    }

    fn next_frame(&mut self) -> (ApplicationCaptureFrame, usize, bool) {
        let mut missing = 0;
        let mut underflow = false;
        if self.output_cursor >= self.output_frames {
            (missing, underflow) = self.refill();
        }
        if self.output_cursor >= self.output_frames {
            return ([0.0, 0.0], missing.max(1), true);
        }
        let offset = self.output_cursor * 2;
        let frame = [self.output_buffer[offset], self.output_buffer[offset + 1]];
        self.output_cursor += 1;
        (frame, missing, underflow)
    }
}

pub struct PreparedApplicationCapture {
    pub source_sample_rate: u32,
    pub source_channel_count: u32,
    reader: StereoAdaptiveReader,
    pub(crate) state: Arc<ApplicationCaptureState>,
}

impl PreparedApplicationCapture {
    #[cfg(any(test, feature = "bench-internals", feature = "test-support"))]
    pub(crate) fn for_test(
        sample_rate: u32,
    ) -> Result<(Self, HeapProd<ApplicationCaptureFrame>), ApplicationCaptureError> {
        let logical_target = ApplicationCaptureLogicalTarget {
            platform: "macos".to_owned(),
            bundle_identifier: Some("live.minori.heron.test".to_owned()),
            executable_path: "/Applications/Test.app/Contents/MacOS/Test".to_owned(),
            executable_name: "Test".to_owned(),
            include_process_tree: true,
        };
        Self::new(
            ApplicationCaptureTargetDescriptor {
                runtime_id: "test-application".to_owned(),
                process_id: 1,
                display_name: "Test".to_owned(),
                executable_path: logical_target.executable_path.clone(),
                logical_target,
                channel_count: 2,
                status: "inactive".to_owned(),
            },
            sample_rate,
            sample_rate,
            2,
            256,
        )
    }

    pub(crate) fn new(
        descriptor: ApplicationCaptureTargetDescriptor,
        source_sample_rate: u32,
        session_sample_rate: u32,
        source_channel_count: u32,
        source_block_frames: usize,
    ) -> Result<(Self, HeapProd<ApplicationCaptureFrame>), ApplicationCaptureError> {
        let source_block_frames = source_block_frames.max(1);
        let capacity = source_block_frames.saturating_mul(APPLICATION_CAPTURE_BUFFER_BLOCKS);
        let (mut producer, consumer) = HeapRb::<ApplicationCaptureFrame>::new(capacity).split();
        for _ in 0..source_block_frames {
            let _ = producer.try_push([0.0, 0.0]);
        }
        let reader = StereoAdaptiveReader::new(
            consumer,
            source_sample_rate,
            session_sample_rate,
            source_block_frames,
            capacity,
        )?;
        let state = Arc::new(ApplicationCaptureState::new(
            descriptor,
            APPLICATION_CAPTURE_STATUS_INACTIVE,
        ));
        Ok((
            Self {
                source_sample_rate,
                source_channel_count: source_channel_count.clamp(1, 2),
                reader,
                state,
            },
            producer,
        ))
    }

    pub(crate) fn silent(
        descriptor: ApplicationCaptureTargetDescriptor,
        session_sample_rate: u32,
        status: u32,
    ) -> Result<Self, ApplicationCaptureError> {
        let (route, _producer) =
            Self::new(descriptor, session_sample_rate, session_sample_rate, 2, 256)?;
        route.state.status.store(status, Ordering::Release);
        Ok(route)
    }

    pub fn activate(&self) {
        self.state.active.store(true, Ordering::Release);
    }

    pub fn abort(&self) {
        self.state.stop.store(true, Ordering::Release);
    }

    pub fn pop_frame(&mut self) -> ApplicationCaptureFrame {
        let (frame, missing, underflow) = self.reader.next_frame();
        if underflow {
            let missing = u64::try_from(missing).unwrap_or(u64::MAX);
            self.state
                .counters
                .underflow_frames
                .fetch_add(missing, Ordering::Relaxed);
            self.state
                .counters
                .dropout_frames
                .fetch_add(missing, Ordering::Relaxed);
        }
        frame
    }
}

impl Drop for PreparedApplicationCapture {
    fn drop(&mut self) {
        self.state.stop.store(true, Ordering::Release);
    }
}

pub(crate) fn application_capture_status_name(status: u32) -> &'static str {
    match status {
        APPLICATION_CAPTURE_STATUS_INACTIVE => "inactive",
        APPLICATION_CAPTURE_STATUS_CAPTURING => "capturing",
        APPLICATION_CAPTURE_STATUS_NO_STREAM => "no-stream",
        APPLICATION_CAPTURE_STATUS_TARGET_MISSING => "target-missing",
        APPLICATION_CAPTURE_STATUS_AMBIGUOUS_TARGET => "ambiguous-target",
        APPLICATION_CAPTURE_STATUS_TARGET_EXITED => "target-exited",
        APPLICATION_CAPTURE_STATUS_UNSUPPORTED => "unsupported",
        APPLICATION_CAPTURE_STATUS_PERMISSION_DENIED => "permission-denied",
        _ => "error",
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
        #[cfg(target_os = "macos")]
        let backend = MacOsApplicationCaptureBackend::new();
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
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
    ) -> Result<PreparedApplicationCapture, ApplicationCaptureError> {
        self.backend.prepare_capture(target, session_sample_rate)
    }
}

impl Default for ApplicationCaptureManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor() -> ApplicationCaptureTargetDescriptor {
        ApplicationCaptureTargetDescriptor {
            runtime_id: "test-application".to_owned(),
            process_id: 1,
            display_name: "Test".to_owned(),
            executable_path: "/Applications/Test.app/Contents/MacOS/Test".to_owned(),
            logical_target: ApplicationCaptureLogicalTarget {
                platform: "macos".to_owned(),
                bundle_identifier: Some("live.minori.test".to_owned()),
                executable_path: "/Applications/Test.app/Contents/MacOS/Test".to_owned(),
                executable_name: "Test".to_owned(),
                include_process_tree: true,
            },
            channel_count: 2,
            status: "inactive".to_owned(),
        }
    }

    #[test]
    fn prepared_route_is_bounded_primed_and_adaptive() {
        let (mut route, mut producer) =
            PreparedApplicationCapture::new(descriptor(), 48_000, 44_100, 4, 256)
                .expect("valid resampler configuration");
        assert_eq!(route.source_channel_count, 2);
        route.activate();
        assert!(producer.try_push([0.25, -0.25]).is_ok());
        for _ in 0..512 {
            let frame = route.pop_frame();
            assert!(frame[0].is_finite());
            assert!(frame[1].is_finite());
        }
        route.abort();
    }

    #[test]
    fn registry_reads_live_status_and_counters() {
        let registry = ApplicationCaptureRegistry::default();
        let route = PreparedApplicationCapture::silent(
            descriptor(),
            48_000,
            APPLICATION_CAPTURE_STATUS_PERMISSION_DENIED,
        )
        .expect("silent route");
        registry.register(&route.state);
        route
            .state
            .counters
            .overflow_frames
            .store(7, Ordering::Relaxed);
        assert_eq!(registry.snapshot()[0].status, "permission-denied");
        assert_eq!(registry.snapshot()[0].overflow_frames, 7);
    }

    #[test]
    fn adaptive_reader_stays_bounded_with_slow_and_fast_source_clocks() {
        for source_frames_per_output in [0.999_5_f64, 1.000_5_f64] {
            let (mut route, mut producer) =
                PreparedApplicationCapture::new(descriptor(), 48_000, 48_000, 2, 512)
                    .expect("valid clock-drift fixture");
            let mut source_phase = 0.0;
            let mut maximum_fill = 0;
            for _ in 0..200_000 {
                source_phase += source_frames_per_output;
                while source_phase >= 1.0 {
                    producer
                        .try_push([0.25, -0.125])
                        .expect("adaptive reader must prevent long-term overflow");
                    source_phase -= 1.0;
                }
                let frame = route.pop_frame();
                assert!(frame[0].is_finite() && frame[1].is_finite());
                maximum_fill = maximum_fill.max(producer.occupied_len());
            }
            assert!(maximum_fill < 4_096, "source ring must remain bounded");
            assert_eq!(
                route
                    .state
                    .counters
                    .underflow_frames
                    .load(Ordering::Relaxed),
                0,
                "one-block priming and drift correction must avoid systematic underflow"
            );
        }
    }
}
