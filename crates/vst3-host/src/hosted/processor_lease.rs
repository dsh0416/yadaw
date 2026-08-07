use std::{
    cell::{Cell, UnsafeCell},
    marker::PhantomData,
    ptr::NonNull,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{StereoProcessor, processor::HostProcessContext};

use super::{MIDI_AFTERTOUCH, MIDI_PITCH_BEND, MIDI_PROGRAM_CHANGE, MidiMappingTable};

pub(super) struct ProcessorCell {
    processor: UnsafeCell<StereoProcessor>,
    paused: AtomicBool,
    processing: AtomicBool,
}

impl ProcessorCell {
    pub(super) fn new(processor: StereoProcessor) -> Box<Self> {
        Box::new(Self {
            processor: UnsafeCell::new(processor),
            paused: AtomicBool::new(false),
            processing: AtomicBool::new(false),
        })
    }

    pub(super) fn with_paused<T>(&self, action: impl FnOnce(&mut StereoProcessor) -> T) -> T {
        self.paused.store(true, Ordering::Release);
        while self.processing.load(Ordering::Acquire) {
            std::hint::spin_loop();
        }
        let result = unsafe {
            // SAFETY: paused prevents the audio lease from entering and processing is false, so
            // the UI thread has exclusive access until paused is cleared.
            action(&mut *self.processor.get())
        };
        self.paused.store(false, Ordering::Release);
        result
    }
}

pub struct ProcessorLease {
    pub(super) cell: NonNull<ProcessorCell>,
    pub(super) midi_mapping: Arc<MidiMappingTable>,
    pub(super) _lifetime: Arc<()>,
    pub(super) _not_sync: PhantomData<Cell<()>>,
}

impl Clone for ProcessorLease {
    fn clone(&self) -> Self {
        Self {
            cell: self.cell,
            midi_mapping: Arc::clone(&self.midi_mapping),
            _lifetime: Arc::clone(&self._lifetime),
            _not_sync: PhantomData,
        }
    }
}

// SAFETY: A processor lease is transferred to one audio graph generation at a time. The !Sync
// marker prevents shared cross-thread calls; retired graph generations finish before owner drop.
unsafe impl Send for ProcessorLease {}

impl ProcessorLease {
    pub fn process_block(
        &mut self,
        input_left: &mut [f32],
        input_right: &mut [f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
        context: &HostProcessContext,
    ) -> bool {
        self.process_block_with_aux(
            input_left,
            input_right,
            output_left,
            output_right,
            &[],
            context,
        )
    }

    pub(crate) fn process_block_with_aux(
        &mut self,
        input_left: &mut [f32],
        input_right: &mut [f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
        auxiliary_inputs: &[crate::processor::AuxiliaryAudioInput],
        context: &HostProcessContext,
    ) -> bool {
        let cell = unsafe {
            // SAFETY: HostedPlugin keeps the stable ProcessorCell allocation alive for the helper
            // lifetime and graph retirement prevents use after owner drop.
            self.cell.as_ref()
        };
        if cell.paused.load(Ordering::Acquire) || cell.processing.swap(true, Ordering::AcqRel) {
            return false;
        }
        if cell.paused.load(Ordering::Acquire) {
            cell.processing.store(false, Ordering::Release);
            return false;
        }
        let result = unsafe {
            // SAFETY: processing is an exclusive single-audio-thread guard and the UI pause path
            // waits for it to clear before accessing the processor.
            (&mut *cell.processor.get()).process_stereo_with_aux_context(
                input_left,
                input_right,
                output_left,
                output_right,
                auxiliary_inputs,
                Some(context),
            )
        };
        cell.processing.store(false, Ordering::Release);
        result.is_ok()
    }

    pub fn note_on(
        &mut self,
        sample_offset: i32,
        channel: u8,
        key: u8,
        velocity: u8,
        note_id: i32,
    ) -> bool {
        self.queue_note(true, sample_offset, channel, key, velocity, note_id)
    }

    pub fn note_off(
        &mut self,
        sample_offset: i32,
        channel: u8,
        key: u8,
        velocity: u8,
        note_id: i32,
    ) -> bool {
        self.queue_note(false, sample_offset, channel, key, velocity, note_id)
    }

    fn queue_note(
        &mut self,
        note_on: bool,
        sample_offset: i32,
        channel: u8,
        key: u8,
        velocity: u8,
        note_id: i32,
    ) -> bool {
        let cell = unsafe {
            // SAFETY: the owner keeps this stable cell alive for the lease lifetime.
            self.cell.as_ref()
        };
        if cell.paused.load(Ordering::Acquire) {
            return false;
        }
        unsafe {
            // SAFETY: note scheduling is called by the same single audio thread as process_block.
            let processor = &mut *cell.processor.get();
            if note_on {
                processor.queue_note_on(
                    sample_offset,
                    i16::from(channel),
                    i16::from(key),
                    f32::from(velocity) / 127.0,
                    note_id,
                )
            } else {
                processor.queue_note_off(
                    sample_offset,
                    i16::from(channel),
                    i16::from(key),
                    f32::from(velocity) / 127.0,
                    note_id,
                )
            }
        }
    }

    pub fn poly_pressure(
        &mut self,
        sample_offset: i32,
        channel: u8,
        key: u8,
        pressure: u8,
    ) -> bool {
        let cell = unsafe {
            // SAFETY: the owner keeps this stable cell alive for the lease lifetime.
            self.cell.as_ref()
        };
        if cell.paused.load(Ordering::Acquire) {
            return false;
        }
        unsafe {
            // SAFETY: MIDI scheduling is called by the same single audio thread as process_block.
            (&mut *cell.processor.get()).queue_poly_pressure(
                sample_offset,
                i16::from(channel),
                i16::from(key),
                f32::from(pressure) / 127.0,
            )
        }
    }

    pub fn sysex(&mut self, sample_offset: i32, bytes: &[u8]) -> bool {
        let cell = unsafe {
            // SAFETY: the owner keeps this stable cell alive for the lease lifetime.
            self.cell.as_ref()
        };
        if cell.paused.load(Ordering::Acquire) {
            return false;
        }
        unsafe {
            // SAFETY: MIDI scheduling is called by the same single audio thread as process_block.
            (&mut *cell.processor.get()).queue_sysex(sample_offset, bytes)
        }
    }

    pub fn control_change(
        &mut self,
        sample_offset: i32,
        channel: u8,
        controller: u8,
        value: u8,
    ) -> bool {
        self.mapped_parameter(
            sample_offset,
            channel,
            usize::from(controller),
            f64::from(value) / 127.0,
        )
    }

    pub fn channel_pressure(&mut self, sample_offset: i32, channel: u8, pressure: u8) -> bool {
        self.mapped_parameter(
            sample_offset,
            channel,
            MIDI_AFTERTOUCH,
            f64::from(pressure) / 127.0,
        )
    }

    pub fn pitch_bend(&mut self, sample_offset: i32, channel: u8, bend: u16) -> bool {
        self.mapped_parameter(
            sample_offset,
            channel,
            MIDI_PITCH_BEND,
            f64::from(bend.min(16_383)) / 16_383.0,
        )
    }

    pub fn program_change(&mut self, sample_offset: i32, channel: u8, program: u8) -> bool {
        self.mapped_parameter(
            sample_offset,
            channel,
            MIDI_PROGRAM_CHANGE,
            f64::from(program) / 127.0,
        )
    }

    fn mapped_parameter(
        &mut self,
        sample_offset: i32,
        channel: u8,
        controller: usize,
        value: f64,
    ) -> bool {
        let Some(parameter_id) = self.midi_mapping.parameter(channel, controller) else {
            return false;
        };
        let cell = unsafe {
            // SAFETY: the owner keeps this stable cell alive for the lease lifetime.
            self.cell.as_ref()
        };
        if cell.paused.load(Ordering::Acquire) {
            return false;
        }
        unsafe {
            // SAFETY: MIDI scheduling is called by the same single audio thread as process_block.
            (&mut *cell.processor.get()).queue_parameter_change(sample_offset, parameter_id, value)
        }
    }
}
