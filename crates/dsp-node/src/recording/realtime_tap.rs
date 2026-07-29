#[cfg(any(test, feature = "bench-internals"))]
pub struct RecordingTap {
    producer: HeapProd<InputFrame>,
    active: Arc<AtomicBool>,
    dropout_frames: Arc<AtomicU64>,
    channel_count: usize,
}

#[cfg(any(test, feature = "bench-internals"))]
impl RecordingTap {
    pub fn push(&mut self, channels: &[f32]) {
        if !self.active.load(Ordering::Relaxed) {
            return;
        }
        let mut frame = [0.0_f32; MAX_INPUT_CHANNELS];
        let count = channels
            .len()
            .min(self.channel_count)
            .min(MAX_INPUT_CHANNELS);
        frame[..count].copy_from_slice(&channels[..count]);
        if self.producer.try_push(frame).is_err() {
            self.dropout_frames.fetch_add(1, Ordering::Relaxed);
        }
    }
}
