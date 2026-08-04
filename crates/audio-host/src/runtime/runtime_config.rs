use super::thread;

#[derive(Debug, Clone, Copy)]
pub(super) struct RuntimeConfig {
    pub(super) worker_threads: usize,
    pub(super) max_blocking_threads: usize,
    pub(super) egress_concurrency: usize,
}

impl RuntimeConfig {
    pub(super) fn auto() -> Self {
        let logical = thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
        let worker_threads = logical.div_ceil(4).clamp(1, 4);
        let max_blocking_threads = (worker_threads * 2).clamp(2, 8);
        Self {
            worker_threads,
            max_blocking_threads,
            egress_concurrency: 2.min(max_blocking_threads),
        }
    }

    pub(super) fn validate(self) -> Result<Self, String> {
        if !(1..=8).contains(&self.worker_threads) {
            return Err("worker threads must be between 1 and 8".into());
        }
        if !(2..=16).contains(&self.max_blocking_threads) {
            return Err("blocking threads must be between 2 and 16".into());
        }
        if !(1..=4).contains(&self.egress_concurrency)
            || self.egress_concurrency > self.max_blocking_threads
        {
            return Err(
                "egress concurrency must be between 1 and 4 and not exceed blocking threads".into(),
            );
        }
        Ok(self)
    }
}
