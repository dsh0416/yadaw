//! Supervised background workers for graph builds (and reserved future I/O jobs).
//!
//! Streaming prefetch and recording still use dedicated pools; this supervisor is
//! the ownership home for graph/PDC construction per `playback-runtime.md`.

use std::{
    cmp::Ordering as CmpOrdering,
    collections::BinaryHeap,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
};

use tokio::sync::oneshot;

use crate::engine::{CompiledGraphBuild, GraphBuildInput, compile_graph_build};

const JOB_CAPACITY: usize = 128;

/// Documented general-job priority order. Lower discriminant runs first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum JobPriority {
    StreamingUnderrun = 0,
    SeekWindow = 1,
    GraphBuild = 2,
    WaveformCache = 3,
}

enum WorkerJob {
    GraphBuild {
        input: GraphBuildInput,
        complete: oneshot::Sender<Result<CompiledGraphBuild, String>>,
    },
}

struct PrioritizedJob {
    priority: JobPriority,
    sequence: u64,
    job: WorkerJob,
}

impl PartialEq for PrioritizedJob {
    fn eq(&self, other: &Self) -> bool {
        self.priority == other.priority && self.sequence == other.sequence
    }
}

impl Eq for PrioritizedJob {}

impl PartialOrd for PrioritizedJob {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl Ord for PrioritizedJob {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        // BinaryHeap is a max-heap: reverse priority so lower discriminants pop first.
        other
            .priority
            .cmp(&self.priority)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}

struct JobQueue {
    jobs: BinaryHeap<PrioritizedJob>,
    closed: bool,
}

struct SharedQueue {
    state: Mutex<JobQueue>,
    available: Condvar,
}

impl SharedQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(JobQueue {
                jobs: BinaryHeap::new(),
                closed: false,
            }),
            available: Condvar::new(),
        }
    }

    fn push(&self, job: PrioritizedJob) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "background worker queue is poisoned".to_owned())?;
        if state.closed {
            return Err("background worker queue is closed".into());
        }
        if state.jobs.len() >= JOB_CAPACITY {
            return Err("background worker queue is full".into());
        }
        state.jobs.push(job);
        self.available.notify_one();
        Ok(())
    }

    fn pop(&self) -> Option<PrioritizedJob> {
        let mut state = self.state.lock().ok()?;
        loop {
            if let Some(job) = state.jobs.pop() {
                return Some(job);
            }
            if state.closed {
                return None;
            }
            state = self.available.wait(state).ok()?;
        }
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.available.notify_all();
        }
    }
}

/// Fixed pool of general background lanes owned by `BackgroundIoActor`.
pub struct WorkerSupervisor {
    queue: Arc<SharedQueue>,
    sequence: AtomicU64,
    shutdown: AtomicBool,
}

impl WorkerSupervisor {
    pub fn new() -> Arc<Self> {
        let lane_count = thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(2)
            .saturating_sub(2)
            .clamp(1, 4);
        let queue = Arc::new(SharedQueue::new());
        for lane in 0..lane_count {
            let queue = Arc::clone(&queue);
            thread::Builder::new()
                .name(format!("yadaw-background-io-{lane}"))
                .spawn(move || worker_lane(queue))
                .expect("background I/O worker must start");
        }
        Arc::new(Self {
            queue,
            sequence: AtomicU64::new(0),
            shutdown: AtomicBool::new(false),
        })
    }

    pub fn submit_graph_build(
        &self,
        input: GraphBuildInput,
    ) -> Result<oneshot::Receiver<Result<CompiledGraphBuild, String>>, String> {
        if self.shutdown.load(Ordering::Acquire) {
            return Err("background worker supervisor is shut down".into());
        }
        let (complete_tx, complete_rx) = oneshot::channel();
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        self.queue.push(PrioritizedJob {
            priority: JobPriority::GraphBuild,
            sequence,
            job: WorkerJob::GraphBuild {
                input,
                complete: complete_tx,
            },
        })?;
        Ok(complete_rx)
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.queue.close();
    }
}

impl Drop for WorkerSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn worker_lane(queue: Arc<SharedQueue>) {
    while let Some(PrioritizedJob { job, .. }) = queue.pop() {
        match job {
            WorkerJob::GraphBuild { input, complete } => {
                let result = compile_graph_build(input).map_err(|error| error.to_string());
                let _ = complete.send(result);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{
        GRAPH_TEST_LOCK, NativeMixerChannel, NativeMixerGraph, PublishOutcome, begin_graph_build,
        last_native_graph_generation_for_test, latest_build_generation_for_test,
        publish_mixer_runtime, set_last_native_graph_for_test,
    };
    use yadaw_dsp_runtime::tempo::{TempoEvent, TimeSignatureEvent};

    fn minimal_graph(generation: u64) -> NativeMixerGraph {
        NativeMixerGraph {
            generation,
            sample_rate: 48_000,
            channels: vec![
                NativeMixerChannel {
                    id: "audio".into(),
                    kind: "audio".into(),
                    system_role: None,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output_index: Some(2),
                    output_bus: None,
                    record_armed: false,
                    input_monitoring: false,
                    input_source: Some("hardware".into()),
                    input_channels: vec![1, 2],
                    hardware_output_channels: vec![],
                    midi_input_port_id: None,
                    midi_input_channel: None,
                },
                NativeMixerChannel {
                    id: "master".into(),
                    kind: "master".into(),
                    system_role: None,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output_index: None,
                    output_bus: None,
                    record_armed: false,
                    input_monitoring: false,
                    input_source: None,
                    input_channels: vec![],
                    hardware_output_channels: vec![],
                    midi_input_port_id: None,
                    midi_input_channel: None,
                },
                NativeMixerChannel {
                    id: "output".into(),
                    kind: "output".into(),
                    system_role: None,
                    gain_db: 0.0,
                    pan: 0.0,
                    muted: false,
                    soloed: false,
                    output_index: None,
                    output_bus: None,
                    record_armed: false,
                    input_monitoring: false,
                    input_source: None,
                    input_channels: vec![],
                    hardware_output_channels: vec![1, 2],
                    midi_input_port_id: None,
                    midi_input_channel: None,
                },
            ],
            sends: vec![],
            clips: vec![],
            plugins: vec![],
            midi_clips: vec![],
            tempo_events: vec![TempoEvent {
                tick: 0,
                beats_per_minute: 120.0,
            }],
            time_signature_events: vec![TimeSignatureEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
        }
    }

    #[test]
    fn newer_build_generation_discards_stale_publish() {
        let _guard = GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let first = begin_graph_build(minimal_graph(1)).expect("first begin");
        let first_generation = first.build_generation();
        // A newer begin must win publication even if the older compile finishes later.
        let second = begin_graph_build(minimal_graph(2)).expect("second begin");
        assert!(second.build_generation() > first_generation);
        assert_eq!(
            latest_build_generation_for_test(),
            second.build_generation()
        );

        let stale = compile_graph_build(first).expect("stale compile");
        assert_eq!(
            publish_mixer_runtime(stale).expect("stale publish"),
            PublishOutcome::Superseded
        );

        let current = compile_graph_build(second).expect("current compile");
        assert_eq!(
            publish_mixer_runtime(current).expect("current publish"),
            PublishOutcome::Published
        );
    }

    #[test]
    fn supervisor_compiles_graph_builds_on_worker_lanes() {
        let _guard = GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let supervisor = WorkerSupervisor::new();
        let input = begin_graph_build(minimal_graph(3)).expect("begin");
        let receiver = supervisor
            .submit_graph_build(input)
            .expect("submit graph build");
        let built = receiver
            .blocking_recv()
            .expect("worker reply")
            .expect("compile");
        assert_eq!(
            publish_mixer_runtime(built).expect("publish"),
            PublishOutcome::Published
        );
        supervisor.shutdown();
    }

    #[test]
    fn preparing_and_compiling_do_not_replace_the_committed_recovery_graph() {
        let _guard = GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_last_native_graph_for_test(None);
        let input = begin_graph_build(minimal_graph(41)).expect("prepare");
        assert_eq!(last_native_graph_generation_for_test(), None);

        let built = compile_graph_build(input).expect("compile");
        assert_eq!(last_native_graph_generation_for_test(), None);

        assert_eq!(
            publish_mixer_runtime(built).expect("activate"),
            PublishOutcome::Published
        );
        assert_eq!(last_native_graph_generation_for_test(), Some(41));
        set_last_native_graph_for_test(None);
    }

    #[test]
    fn job_priority_orders_underrun_ahead_of_graph_build() {
        assert!(JobPriority::StreamingUnderrun < JobPriority::SeekWindow);
        assert!(JobPriority::SeekWindow < JobPriority::GraphBuild);
        assert!(JobPriority::GraphBuild < JobPriority::WaveformCache);
    }

    #[test]
    fn prioritized_jobs_pop_lower_priority_discriminants_first() {
        let _guard = GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let queue = SharedQueue::new();
        let graph_input = begin_graph_build(minimal_graph(50)).expect("graph begin");
        let seek_input = begin_graph_build(minimal_graph(51)).expect("seek begin");
        let (graph_tx, _) = oneshot::channel();
        let (seek_tx, _) = oneshot::channel();
        queue
            .push(PrioritizedJob {
                priority: JobPriority::GraphBuild,
                sequence: 1,
                job: WorkerJob::GraphBuild {
                    input: graph_input,
                    complete: graph_tx,
                },
            })
            .expect("push graph job");
        queue
            .push(PrioritizedJob {
                priority: JobPriority::SeekWindow,
                sequence: 2,
                job: WorkerJob::GraphBuild {
                    input: seek_input,
                    complete: seek_tx,
                },
            })
            .expect("push seek job");

        let first = queue.pop().expect("first job");
        assert_eq!(first.priority, JobPriority::SeekWindow);
        let second = queue.pop().expect("second job");
        assert_eq!(second.priority, JobPriority::GraphBuild);
        queue.close();
    }

    #[test]
    fn closed_queue_rejects_new_jobs_and_shutdown_rejects_submits() {
        let _guard = GRAPH_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let queue = SharedQueue::new();
        queue.close();
        let input = begin_graph_build(minimal_graph(52)).expect("begin");
        let (complete, _) = oneshot::channel();
        let error = queue
            .push(PrioritizedJob {
                priority: JobPriority::GraphBuild,
                sequence: 0,
                job: WorkerJob::GraphBuild { input, complete },
            })
            .expect_err("closed queue must reject push");
        assert!(error.contains("closed"));

        let supervisor = WorkerSupervisor::new();
        supervisor.shutdown();
        let input = begin_graph_build(minimal_graph(53)).expect("begin");
        let error = match supervisor.submit_graph_build(input) {
            Ok(_) => panic!("shutdown supervisor must reject submit"),
            Err(error) => error,
        };
        assert!(error.contains("shut down"));
    }
}
