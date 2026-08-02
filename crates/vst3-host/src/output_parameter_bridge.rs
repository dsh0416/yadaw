use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

struct OutputParameterSlot {
    value: AtomicU64,
    sequence: AtomicU64,
}

impl OutputParameterSlot {
    const fn new() -> Self {
        Self {
            value: AtomicU64::new(0),
            sequence: AtomicU64::new(0),
        }
    }

    fn publish(&self, value: f64) {
        // One audio processor is the sole writer. Mark the slot odd before
        // replacing its payload and even after publication so the UI reader
        // never accepts a value from a torn publication.
        self.sequence.fetch_add(1, Ordering::AcqRel);
        self.value.store(value.to_bits(), Ordering::Relaxed);
        self.sequence.fetch_add(1, Ordering::Release);
    }

    fn read_after(&self, consumed_sequence: u64) -> Option<(u64, f64)> {
        let before = self.sequence.load(Ordering::Acquire);
        if before == consumed_sequence || before & 1 != 0 {
            return None;
        }
        let value = f64::from_bits(self.value.load(Ordering::Relaxed));
        let after = self.sequence.load(Ordering::Acquire);
        (before == after && after & 1 == 0).then_some((after, value))
    }
}

struct OutputParameterBridge {
    indices: HashMap<u32, usize>,
    slots: Box<[OutputParameterSlot]>,
}

pub(crate) struct OutputParameterWriter {
    bridge: Arc<OutputParameterBridge>,
}

pub(crate) struct OutputParameterReader {
    bridge: Arc<OutputParameterBridge>,
    consumed_sequences: Box<[u64]>,
}

pub(crate) fn output_parameter_bridge(
    parameter_ids: impl IntoIterator<Item = u32>,
) -> (OutputParameterWriter, OutputParameterReader) {
    let mut indices = HashMap::new();
    for id in parameter_ids {
        let next = indices.len();
        indices.entry(id).or_insert(next);
    }
    let slots = std::iter::repeat_with(OutputParameterSlot::new)
        .take(indices.len())
        .collect::<Box<[_]>>();
    let consumed_sequences = vec![0; slots.len()].into_boxed_slice();
    let bridge = Arc::new(OutputParameterBridge { indices, slots });
    (
        OutputParameterWriter {
            bridge: Arc::clone(&bridge),
        },
        OutputParameterReader {
            bridge,
            consumed_sequences,
        },
    )
}

impl OutputParameterWriter {
    /// Publish one normalized processor output without allocating or blocking.
    pub(crate) fn publish(&self, id: u32, value: f64) -> bool {
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return false;
        }
        let Some(slot) = self
            .bridge
            .indices
            .get(&id)
            .and_then(|index| self.bridge.slots.get(*index))
        else {
            return false;
        };
        slot.publish(value);
        true
    }
}

impl OutputParameterReader {
    /// Apply every parameter whose latest publication has not been consumed.
    pub(crate) fn drain(&mut self, mut apply: impl FnMut(u32, f64)) -> usize {
        let mut applied = 0;
        for (&id, &index) in &self.bridge.indices {
            let Some((sequence, value)) =
                self.bridge.slots[index].read_after(self.consumed_sequences[index])
            else {
                continue;
            };
            self.consumed_sequences[index] = sequence;
            apply(id, value);
            applied += 1;
        }
        applied
    }
}

#[cfg(test)]
mod tests {
    use std::thread;

    use super::*;

    #[test]
    fn bridge_keeps_only_the_latest_value_for_each_parameter() {
        let (writer, mut reader) = output_parameter_bridge([7, 9]);
        assert!(writer.publish(7, 0.25));
        assert!(writer.publish(7, 0.75));
        assert!(writer.publish(9, 0.5));
        assert!(!writer.publish(11, 0.5));
        assert!(!writer.publish(7, f64::NAN));

        let mut values = HashMap::new();
        assert_eq!(reader.drain(|id, value| _ = values.insert(id, value)), 2);
        assert_eq!(values.get(&7), Some(&0.75));
        assert_eq!(values.get(&9), Some(&0.5));
        assert_eq!(reader.drain(|_, _| {}), 0);
    }

    #[test]
    fn concurrent_publication_never_exposes_a_torn_float() {
        const PUBLICATIONS: u64 = 100_000;
        let (writer, mut reader) = output_parameter_bridge([42]);
        let producer = thread::spawn(move || {
            for value in 1..=PUBLICATIONS {
                assert!(writer.publish(42, value as f64 / PUBLICATIONS as f64));
            }
        });

        let mut last = 0.0;
        while !producer.is_finished() {
            reader.drain(|id, value| {
                assert_eq!(id, 42);
                assert!((0.0..=1.0).contains(&value));
                last = value;
            });
            thread::yield_now();
        }
        producer.join().expect("publisher exits normally");
        reader.drain(|_, value| last = value);
        assert_eq!(last, 1.0);
    }
}
