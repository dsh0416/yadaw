use std::{
    cell::Cell,
    mem::size_of,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr::NonNull,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering},
    },
};

use clap_sys::{
    audio_buffer::clap_audio_buffer,
    events::{
        CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_MIDI, CLAP_EVENT_MIDI_SYSEX, CLAP_EVENT_NOTE_OFF,
        CLAP_EVENT_NOTE_ON, CLAP_EVENT_PARAM_GESTURE_BEGIN, CLAP_EVENT_PARAM_GESTURE_END,
        CLAP_EVENT_PARAM_VALUE, CLAP_TRANSPORT_HAS_BEATS_TIMELINE, CLAP_TRANSPORT_HAS_TEMPO,
        CLAP_TRANSPORT_HAS_TIME_SIGNATURE, CLAP_TRANSPORT_IS_LOOP_ACTIVE,
        CLAP_TRANSPORT_IS_PLAYING, CLAP_TRANSPORT_IS_RECORDING, clap_event_header, clap_event_midi,
        clap_event_midi_sysex, clap_event_note, clap_event_param_gesture, clap_event_param_value,
        clap_event_transport, clap_input_events, clap_output_events,
    },
    fixedpoint::CLAP_BEATTIME_FACTOR,
    plugin::clap_plugin,
    process::{CLAP_PROCESS_ERROR, CLAP_PROCESS_SLEEP, clap_process},
};
use heron_audio_plugin::{
    AudioPluginProcessor, AudioPortToken, ParameterToken, ProcessContext, SidechainSource,
};

use crate::{ClapAudioPort, ClapHostRequests, ClapNotePort, host::AudioThreadScope};
use clap_sys::ext::note_ports::{CLAP_NOTE_DIALECT_CLAP, CLAP_NOTE_DIALECT_MIDI};

const EVENT_CAPACITY: usize = 2_048;
const SYSEX_CAPACITY: usize = 64 * 1024;
const PARAMETER_QUEUE_CAPACITY: usize = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClapParameterGesture {
    Begin,
    Perform,
    End,
}

#[derive(Clone, Copy)]
enum NoteDialect {
    Clap,
    Midi,
}

struct ParameterSlot {
    id: AtomicU32,
    offset: AtomicU32,
    value: AtomicU64,
    gesture: AtomicU8,
}

struct ParameterQueue {
    slots: Box<[ParameterSlot]>,
    head: AtomicUsize,
    tail: AtomicUsize,
}

impl ParameterQueue {
    fn new() -> Self {
        Self {
            slots: (0..PARAMETER_QUEUE_CAPACITY)
                .map(|_| ParameterSlot {
                    id: AtomicU32::new(0),
                    offset: AtomicU32::new(0),
                    value: AtomicU64::new(0),
                    gesture: AtomicU8::new(1),
                })
                .collect(),
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }

    fn push(&self, id: u32, value: f64, gesture: ClapParameterGesture, offset: u32) -> bool {
        let tail = self.tail.load(Ordering::Relaxed);
        let next = (tail + 1) % self.slots.len();
        if next == self.head.load(Ordering::Acquire) {
            return false;
        }
        let slot = &self.slots[tail];
        slot.id.store(id, Ordering::Relaxed);
        slot.offset.store(offset, Ordering::Relaxed);
        slot.value.store(value.to_bits(), Ordering::Relaxed);
        slot.gesture.store(
            match gesture {
                ClapParameterGesture::Begin => 0,
                ClapParameterGesture::Perform => 1,
                ClapParameterGesture::End => 2,
            },
            Ordering::Relaxed,
        );
        self.tail.store(next, Ordering::Release);
        true
    }

    fn pop(&self) -> Option<(u32, f64, ClapParameterGesture, u32)> {
        let head = self.head.load(Ordering::Relaxed);
        if head == self.tail.load(Ordering::Acquire) {
            return None;
        }
        let slot = &self.slots[head];
        let gesture = match slot.gesture.load(Ordering::Relaxed) {
            0 => ClapParameterGesture::Begin,
            2 => ClapParameterGesture::End,
            _ => ClapParameterGesture::Perform,
        };
        let value = (
            slot.id.load(Ordering::Relaxed),
            f64::from_bits(slot.value.load(Ordering::Relaxed)),
            gesture,
            slot.offset.load(Ordering::Relaxed),
        );
        self.head
            .store((head + 1) % self.slots.len(), Ordering::Release);
        Some(value)
    }
}

#[derive(Clone)]
enum InputEvent {
    Note(clap_event_note),
    Midi(clap_event_midi),
    Sysex(clap_event_midi_sysex),
    Parameter(clap_event_param_value),
    Gesture(clap_event_param_gesture),
}

impl InputEvent {
    fn header(&self) -> *const clap_event_header {
        match self {
            Self::Note(event) => &event.header,
            Self::Midi(event) => &event.header,
            Self::Sysex(event) => &event.header,
            Self::Parameter(event) => &event.header,
            Self::Gesture(event) => &event.header,
        }
    }
}

struct InputEventBuffer {
    events: Vec<InputEvent>,
    sysex: Vec<u8>,
}

impl Clone for InputEventBuffer {
    fn clone(&self) -> Self {
        Self {
            events: Vec::with_capacity(EVENT_CAPACITY),
            sysex: Vec::with_capacity(SYSEX_CAPACITY),
        }
    }
}

struct PortBuffer {
    id: u32,
    channels: Vec<Vec<f32>>,
    pointers: Vec<ChannelPointer>,
}

struct ChannelPointer(*mut f32);

// SAFETY: Each pointer refers to a channel allocation owned by the same
// `PortBuffer`. Moving the buffer between threads does not move those heap
// allocations, and pointers are refreshed before every process call.
unsafe impl Send for ChannelPointer {}

impl PortBuffer {
    fn new(id: u32, channels: usize, maximum_frames: usize) -> Self {
        let mut channels = (0..channels)
            .map(|_| vec![0.0; maximum_frames])
            .collect::<Vec<_>>();
        let pointers = channels
            .iter_mut()
            .map(|channel| ChannelPointer(channel.as_mut_ptr()))
            .collect();
        Self {
            id,
            channels,
            pointers,
        }
    }

    fn raw(&mut self) -> clap_audio_buffer {
        for (pointer, channel) in self.pointers.iter_mut().zip(&mut self.channels) {
            pointer.0 = channel.as_mut_ptr();
        }
        clap_audio_buffer {
            data32: self.pointers.as_mut_ptr().cast::<*mut f32>(),
            data64: std::ptr::null_mut(),
            channel_count: self.channels.len() as u32,
            latency: 0,
            constant_mask: 0,
        }
    }
}

impl Clone for PortBuffer {
    fn clone(&self) -> Self {
        Self::new(self.id, self.channels.len(), self.channels[0].len())
    }
}

struct PluginPointer(NonNull<clap_plugin>);

// SAFETY: The CLAP instance is activated before publication. Only the
// `ClapProcessorHandle` invokes audio-thread functions, and it is `!Sync`.
unsafe impl Send for PluginPointer {}

/// Preallocated CLAP audio-thread endpoint.
pub struct ClapProcessorHandle {
    plugin: PluginPointer,
    inputs: Vec<PortBuffer>,
    outputs: Vec<PortBuffer>,
    raw_inputs: Vec<clap_audio_buffer>,
    raw_outputs: Vec<clap_audio_buffer>,
    events: InputEventBuffer,
    requests: Arc<ClapHostRequests>,
    lifecycle: Arc<AtomicU8>,
    leases: Arc<AtomicUsize>,
    parameters: Arc<ParameterQueue>,
    output_parameters: Arc<ParameterQueue>,
    note_dialect: Option<NoteDialect>,
    started_here: bool,
    sleeping: bool,
    maximum_frames: usize,
    _not_sync: Cell<()>,
}

impl ClapProcessorHandle {
    pub(crate) fn new(
        plugin: NonNull<clap_plugin>,
        ports: Vec<ClapAudioPort>,
        note_ports: Vec<ClapNotePort>,
        maximum_frames: usize,
        requests: Arc<ClapHostRequests>,
        lifecycle: Arc<AtomicU8>,
        leases: Arc<AtomicUsize>,
    ) -> Result<Self, ()> {
        if maximum_frames == 0 || maximum_frames > u32::MAX as usize {
            return Err(());
        }
        if ports.iter().any(|port| port.channel_count == 0) {
            return Err(());
        }
        let inputs = ports
            .iter()
            .filter(|port| port.is_input)
            .map(|port| PortBuffer::new(port.id, port.channel_count as usize, maximum_frames))
            .collect::<Vec<_>>();
        let outputs = ports
            .iter()
            .filter(|port| !port.is_input)
            .map(|port| PortBuffer::new(port.id, port.channel_count as usize, maximum_frames))
            .collect::<Vec<_>>();
        leases.fetch_add(1, Ordering::AcqRel);
        let note_dialect = note_ports
            .iter()
            .find(|port| port.is_input && port.supported_dialects & CLAP_NOTE_DIALECT_CLAP != 0)
            .map(|_| NoteDialect::Clap)
            .or_else(|| {
                note_ports
                    .iter()
                    .find(|port| {
                        port.is_input && port.supported_dialects & CLAP_NOTE_DIALECT_MIDI != 0
                    })
                    .map(|_| NoteDialect::Midi)
            });
        Ok(Self {
            plugin: PluginPointer(plugin),
            raw_inputs: Vec::with_capacity(inputs.len()),
            raw_outputs: Vec::with_capacity(outputs.len()),
            inputs,
            outputs,
            events: InputEventBuffer {
                events: Vec::with_capacity(EVENT_CAPACITY),
                sysex: Vec::with_capacity(SYSEX_CAPACITY),
            },
            requests,
            lifecycle,
            leases,
            parameters: Arc::new(ParameterQueue::new()),
            output_parameters: Arc::new(ParameterQueue::new()),
            note_dialect,
            started_here: false,
            sleeping: false,
            maximum_frames,
            _not_sync: Cell::new(()),
        })
    }

    fn start(&mut self) -> bool {
        if self.started_here {
            return true;
        }
        if self
            .lifecycle
            .compare_exchange(1, 2, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        // SAFETY: The lifecycle transition guarantees one audio-thread start.
        let Some(start) = (unsafe { self.plugin.0.as_ref() }).start_processing else {
            self.lifecycle.store(1, Ordering::Release);
            return false;
        };
        let _audio_thread = AudioThreadScope::enter();
        // SAFETY: This call occurs on the processing thread after activation.
        if !unsafe { start(self.plugin.0.as_ptr()) } {
            self.lifecycle.store(1, Ordering::Release);
            return false;
        }
        self.started_here = true;
        true
    }

    fn push_note(
        &mut self,
        event_type: u16,
        offset: usize,
        channel: u8,
        key: u8,
        velocity: u8,
        note_id: i32,
    ) -> bool {
        if offset > u32::MAX as usize || self.events.events.len() == EVENT_CAPACITY {
            return false;
        }
        self.events.events.push(InputEvent::Note(clap_event_note {
            header: event_header(size_of::<clap_event_note>(), offset, event_type),
            note_id,
            port_index: 0,
            channel: i16::from(channel),
            key: i16::from(key),
            velocity: f64::from(velocity) / 127.0,
        }));
        true
    }

    fn push_midi(&mut self, offset: usize, data: [u8; 3]) -> bool {
        if offset > u32::MAX as usize || self.events.events.len() == EVENT_CAPACITY {
            return false;
        }
        self.events.events.push(InputEvent::Midi(clap_event_midi {
            header: event_header(size_of::<clap_event_midi>(), offset, CLAP_EVENT_MIDI),
            port_index: 0,
            data,
        }));
        true
    }

    pub fn queue_parameter(&self, id: u32, value: f64, gesture: ClapParameterGesture) -> bool {
        value.is_finite() && self.parameters.push(id, value, gesture, 0)
    }

    /// Drains one parameter value or gesture emitted by the audio thread.
    pub fn take_output_parameter(&self) -> Option<(u32, f64, ClapParameterGesture)> {
        self.output_parameters
            .pop()
            .map(|(id, value, gesture, _)| (id, value, gesture))
    }

    fn drain_parameters(&mut self) {
        while self.events.events.len() < EVENT_CAPACITY {
            let Some((id, value, gesture, offset)) = self.parameters.pop() else {
                break;
            };
            match gesture {
                ClapParameterGesture::Perform => {
                    self.events
                        .events
                        .push(InputEvent::Parameter(clap_event_param_value {
                            header: event_header(
                                size_of::<clap_event_param_value>(),
                                offset as usize,
                                CLAP_EVENT_PARAM_VALUE,
                            ),
                            param_id: id,
                            cookie: std::ptr::null_mut(),
                            note_id: -1,
                            port_index: -1,
                            channel: -1,
                            key: -1,
                            value,
                        }));
                }
                ClapParameterGesture::Begin | ClapParameterGesture::End => {
                    self.events
                        .events
                        .push(InputEvent::Gesture(clap_event_param_gesture {
                            header: event_header(
                                size_of::<clap_event_param_gesture>(),
                                offset as usize,
                                if gesture == ClapParameterGesture::Begin {
                                    CLAP_EVENT_PARAM_GESTURE_BEGIN
                                } else {
                                    CLAP_EVENT_PARAM_GESTURE_END
                                },
                            ),
                            param_id: id,
                        }));
                }
            }
        }
    }
}

impl Clone for ClapProcessorHandle {
    fn clone(&self) -> Self {
        self.leases.fetch_add(1, Ordering::AcqRel);
        Self {
            plugin: PluginPointer(self.plugin.0),
            inputs: self.inputs.clone(),
            outputs: self.outputs.clone(),
            raw_inputs: Vec::with_capacity(self.raw_inputs.capacity()),
            raw_outputs: Vec::with_capacity(self.raw_outputs.capacity()),
            events: self.events.clone(),
            requests: Arc::clone(&self.requests),
            lifecycle: Arc::clone(&self.lifecycle),
            leases: Arc::clone(&self.leases),
            parameters: Arc::clone(&self.parameters),
            output_parameters: Arc::clone(&self.output_parameters),
            note_dialect: self.note_dialect,
            started_here: false,
            sleeping: false,
            maximum_frames: self.maximum_frames,
            _not_sync: Cell::new(()),
        }
    }
}

impl AudioPluginProcessor for ClapProcessorHandle {
    fn clone_box(&self) -> Box<dyn AudioPluginProcessor> {
        Box::new(self.clone())
    }

    fn retire(&mut self) {
        self.stop_on_audio_thread();
    }

    fn process_block(
        &mut self,
        frames: &mut [[f32; 2]],
        sidechains: &dyn SidechainSource,
        context: &ProcessContext,
    ) -> bool {
        if frames.len() > self.maximum_frames || !self.start() {
            return false;
        }
        self.drain_parameters();
        let process_requested = self.requests.take_process_request();
        if self.sleeping
            && !process_requested
            && self.events.events.is_empty()
            && frames.iter().all(|frame| *frame == [0.0, 0.0])
        {
            frames.fill([0.0, 0.0]);
            return true;
        }
        let frame_count = frames.len();
        for (port_index, port) in self.inputs.iter_mut().enumerate() {
            let source = if port_index == 0 {
                None
            } else {
                sidechains.frames(AudioPortToken::new(port.id))
            };
            for frame_index in 0..frame_count {
                let frame = source
                    .and_then(|source| source.get(frame_index).copied())
                    .unwrap_or(frames[frame_index]);
                if let Some(left) = port.channels.get_mut(0) {
                    left[frame_index] = frame[0];
                }
                if let Some(right) = port.channels.get_mut(1) {
                    right[frame_index] = frame[1];
                }
            }
        }
        for port in &mut self.outputs {
            for channel in &mut port.channels {
                channel[..frame_count].fill(0.0);
            }
        }
        self.raw_inputs.clear();
        self.raw_outputs.clear();
        self.raw_inputs
            .extend(self.inputs.iter_mut().map(PortBuffer::raw));
        self.raw_outputs
            .extend(self.outputs.iter_mut().map(PortBuffer::raw));

        let transport = transport(context);
        let input_events = clap_input_events {
            ctx: (&mut self.events as *mut InputEventBuffer).cast(),
            size: Some(input_event_count),
            get: Some(input_event_get),
        };
        let output_events = clap_output_events {
            ctx: Arc::as_ptr(&self.output_parameters).cast_mut().cast(),
            try_push: Some(push_output_event),
        };
        let process = clap_process {
            steady_time: context.steady_time_samples,
            frames_count: frame_count as u32,
            transport: &transport,
            audio_inputs: self.raw_inputs.as_ptr(),
            audio_outputs: self.raw_outputs.as_mut_ptr(),
            audio_inputs_count: self.raw_inputs.len() as u32,
            audio_outputs_count: self.raw_outputs.len() as u32,
            in_events: &input_events,
            out_events: &output_events,
        };
        // SAFETY: All process buffers and event interfaces remain live for the
        // call and were fully preallocated outside the audio callback.
        let _audio_thread = AudioThreadScope::enter();
        // SAFETY: The processor lease keeps the initialized plug-in alive.
        let plugin = unsafe { self.plugin.0.as_ref() };
        let status = plugin.process.map_or(CLAP_PROCESS_ERROR, |process_plugin| {
            // SAFETY: All process buffers and event interfaces remain live for this call.
            unsafe { process_plugin(self.plugin.0.as_ptr(), &process) }
        });
        self.events.events.clear();
        self.events.sysex.clear();
        if status == CLAP_PROCESS_ERROR {
            return false;
        }
        self.sleeping = status == CLAP_PROCESS_SLEEP;
        if let Some(output) = self.outputs.first() {
            for (index, frame) in frames.iter_mut().enumerate() {
                frame[0] = output
                    .channels
                    .first()
                    .map_or(0.0, |channel| channel[index]);
                frame[1] = output
                    .channels
                    .get(1)
                    .or_else(|| output.channels.first())
                    .map_or(0.0, |channel| channel[index]);
            }
        }
        true
    }

    fn parameter(&mut self, offset: usize, token: ParameterToken, value: f64) -> bool {
        offset <= self.maximum_frames
            && value.is_finite()
            && self.parameters.push(
                token.get(),
                value,
                ClapParameterGesture::Perform,
                offset as u32,
            )
    }

    fn note_on(&mut self, offset: usize, channel: u8, key: u8, velocity: u8, note_id: i32) -> bool {
        match self.note_dialect {
            Some(NoteDialect::Clap) => {
                self.push_note(CLAP_EVENT_NOTE_ON, offset, channel, key, velocity, note_id)
            }
            Some(NoteDialect::Midi) => {
                self.push_midi(offset, [0x90 | (channel & 0x0f), key, velocity])
            }
            None => false,
        }
    }

    fn note_off(
        &mut self,
        offset: usize,
        channel: u8,
        key: u8,
        velocity: u8,
        note_id: i32,
    ) -> bool {
        match self.note_dialect {
            Some(NoteDialect::Clap) => {
                self.push_note(CLAP_EVENT_NOTE_OFF, offset, channel, key, velocity, note_id)
            }
            Some(NoteDialect::Midi) => {
                self.push_midi(offset, [0x80 | (channel & 0x0f), key, velocity])
            }
            None => false,
        }
    }

    fn poly_pressure(&mut self, offset: usize, channel: u8, key: u8, pressure: u8) -> bool {
        matches!(self.note_dialect, Some(NoteDialect::Midi))
            && self.push_midi(offset, [0xA0 | (channel & 0x0F), key, pressure])
    }

    fn control_change(&mut self, offset: usize, channel: u8, controller: u8, value: u8) -> bool {
        matches!(self.note_dialect, Some(NoteDialect::Midi))
            && self.push_midi(offset, [0xB0 | (channel & 0x0F), controller, value])
    }

    fn pitch_bend(&mut self, offset: usize, channel: u8, value: u16) -> bool {
        matches!(self.note_dialect, Some(NoteDialect::Midi))
            && self.push_midi(
                offset,
                [
                    0xE0 | (channel & 0x0F),
                    (value & 0x7F) as u8,
                    ((value >> 7) & 0x7F) as u8,
                ],
            )
    }

    fn channel_pressure(&mut self, offset: usize, channel: u8, pressure: u8) -> bool {
        matches!(self.note_dialect, Some(NoteDialect::Midi))
            && self.push_midi(offset, [0xD0 | (channel & 0x0F), pressure, 0])
    }

    fn program_change(&mut self, offset: usize, channel: u8, program: u8) -> bool {
        matches!(self.note_dialect, Some(NoteDialect::Midi))
            && self.push_midi(offset, [0xC0 | (channel & 0x0F), program, 0])
    }

    fn sysex(&mut self, offset: usize, bytes: &[u8]) -> bool {
        if offset > u32::MAX as usize
            || self.events.events.len() == EVENT_CAPACITY
            || self.events.sysex.len().saturating_add(bytes.len()) > SYSEX_CAPACITY
        {
            return false;
        }
        let start = self.events.sysex.len();
        self.events.sysex.extend_from_slice(bytes);
        // No reallocation can occur because capacity is fixed and checked.
        let buffer = self.events.sysex[start..].as_ptr();
        self.events
            .events
            .push(InputEvent::Sysex(clap_event_midi_sysex {
                header: event_header(
                    size_of::<clap_event_midi_sysex>(),
                    offset,
                    CLAP_EVENT_MIDI_SYSEX,
                ),
                port_index: 0,
                buffer,
                size: bytes.len() as u32,
            }));
        true
    }
}

impl Drop for ClapProcessorHandle {
    fn drop(&mut self) {
        self.stop_on_audio_thread();
        self.leases.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ClapProcessorHandle {
    fn stop_on_audio_thread(&mut self) {
        if self.started_here && self.lifecycle.swap(1, Ordering::AcqRel) == 2 {
            let _audio_thread = AudioThreadScope::enter();
            // SAFETY: Graph retirement invokes this on the audio thread,
            // balancing the successful `start_processing` call.
            if let Some(stop) = (unsafe { self.plugin.0.as_ref() }).stop_processing {
                // SAFETY: This endpoint owns the successful started transition.
                unsafe { stop(self.plugin.0.as_ptr()) };
            }
        }
        self.started_here = false;
    }
}

fn event_header(size: usize, time: usize, event_type: u16) -> clap_event_header {
    clap_event_header {
        size: size as u32,
        time: time as u32,
        space_id: CLAP_CORE_EVENT_SPACE_ID,
        type_: event_type,
        flags: 0,
    }
}

fn transport(context: &ProcessContext) -> clap_event_transport {
    let mut flags = CLAP_TRANSPORT_HAS_TEMPO
        | CLAP_TRANSPORT_HAS_BEATS_TIMELINE
        | CLAP_TRANSPORT_HAS_TIME_SIGNATURE;
    if context.playing {
        flags |= CLAP_TRANSPORT_IS_PLAYING;
    }
    if context.recording {
        flags |= CLAP_TRANSPORT_IS_RECORDING;
    }
    if context.loop_active {
        flags |= CLAP_TRANSPORT_IS_LOOP_ACTIVE;
    }
    clap_event_transport {
        header: event_header(size_of::<clap_event_transport>(), 0, 9),
        flags,
        song_pos_beats: fixed(context.project_time_quarters, CLAP_BEATTIME_FACTOR),
        song_pos_seconds: 0,
        tempo: context.tempo,
        tempo_inc: 0.0,
        loop_start_beats: fixed(context.loop_start_quarters, CLAP_BEATTIME_FACTOR),
        loop_end_beats: fixed(context.loop_end_quarters, CLAP_BEATTIME_FACTOR),
        loop_start_seconds: 0,
        loop_end_seconds: 0,
        bar_start: fixed(context.bar_position_quarters, CLAP_BEATTIME_FACTOR),
        bar_number: 0,
        tsig_num: context.time_signature_numerator.clamp(0, u16::MAX as i32) as u16,
        tsig_denom: context.time_signature_denominator.clamp(0, u16::MAX as i32) as u16,
    }
}

fn fixed(value: f64, factor: i64) -> i64 {
    (value * factor as f64).clamp(i64::MIN as f64, i64::MAX as f64) as i64
}

unsafe extern "C" fn input_event_count(list: *const clap_input_events) -> u32 {
    catch_unwind(AssertUnwindSafe(|| {
        if list.is_null() {
            return 0;
        }
        // SAFETY: `ctx` points to the live event buffer for this process call.
        unsafe { (*list).ctx.cast::<InputEventBuffer>().as_ref() }
            .map_or(0, |buffer| buffer.events.len() as u32)
    }))
    .unwrap_or(0)
}

unsafe extern "C" fn input_event_get(
    list: *const clap_input_events,
    index: u32,
) -> *const clap_event_header {
    catch_unwind(AssertUnwindSafe(|| {
        if list.is_null() {
            return std::ptr::null();
        }
        // SAFETY: `ctx` points to the live event buffer for this process call.
        unsafe { (*list).ctx.cast::<InputEventBuffer>().as_ref() }
            .and_then(|buffer| buffer.events.get(index as usize))
            .map_or(std::ptr::null(), InputEvent::header)
    }))
    .unwrap_or(std::ptr::null())
}

unsafe extern "C" fn push_output_event(
    list: *const clap_output_events,
    event: *const clap_event_header,
) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        if list.is_null() || event.is_null() {
            return false;
        }
        // SAFETY: The process call installs a live shared queue in `ctx`.
        let Some(queue) = (unsafe { (*list).ctx.cast::<ParameterQueue>().as_ref() }) else {
            return false;
        };
        // SAFETY: CLAP requires every output event to begin with this header.
        let header = unsafe { &*event };
        if header.space_id != CLAP_CORE_EVENT_SPACE_ID {
            return false;
        }
        match header.type_ {
            CLAP_EVENT_PARAM_VALUE
                if header.size as usize >= size_of::<clap_event_param_value>() =>
            {
                // SAFETY: The checked header size and event type identify this layout.
                let value = unsafe { &*event.cast::<clap_event_param_value>() };
                value.value.is_finite()
                    && queue.push(
                        value.param_id,
                        value.value,
                        ClapParameterGesture::Perform,
                        header.time,
                    )
            }
            CLAP_EVENT_PARAM_GESTURE_BEGIN | CLAP_EVENT_PARAM_GESTURE_END
                if header.size as usize >= size_of::<clap_event_param_gesture>() =>
            {
                // SAFETY: The checked header size and event type identify this layout.
                let gesture = unsafe { &*event.cast::<clap_event_param_gesture>() };
                queue.push(
                    gesture.param_id,
                    0.0,
                    if header.type_ == CLAP_EVENT_PARAM_GESTURE_BEGIN {
                        ClapParameterGesture::Begin
                    } else {
                        ClapParameterGesture::End
                    },
                    header.time,
                )
            }
            _ => false,
        }
    }))
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parameter_queue_is_bounded_fifo_with_offsets() {
        let queue = ParameterQueue::new();
        assert!(queue.push(7, 0.25, ClapParameterGesture::Begin, 3));
        assert!(queue.push(7, 0.5, ClapParameterGesture::Perform, 9));
        assert_eq!(queue.pop(), Some((7, 0.25, ClapParameterGesture::Begin, 3)));
        assert_eq!(
            queue.pop(),
            Some((7, 0.5, ClapParameterGesture::Perform, 9))
        );
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn output_callback_rejects_malformed_events_without_panicking() {
        let queue = ParameterQueue::new();
        let list = clap_output_events {
            ctx: (&queue as *const ParameterQueue).cast_mut().cast(),
            try_push: Some(push_output_event),
        };
        let malformed = clap_event_header {
            size: 1,
            time: 0,
            space_id: CLAP_CORE_EVENT_SPACE_ID,
            type_: CLAP_EVENT_PARAM_VALUE,
            flags: 0,
        };
        // SAFETY: Both test objects are live, but the deliberately short header
        // must be rejected before any wider event cast.
        assert!(!unsafe { push_output_event(&list, &malformed) });
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn parameter_queue_preserves_every_gesture_and_rejects_overflow() {
        let queue = ParameterQueue::new();
        for index in 0..PARAMETER_QUEUE_CAPACITY - 1 {
            let gesture = match index % 3 {
                0 => ClapParameterGesture::Begin,
                1 => ClapParameterGesture::Perform,
                _ => ClapParameterGesture::End,
            };
            assert!(queue.push(index as u32, index as f64, gesture, index as u32));
        }
        assert!(!queue.push(9_999, 1.0, ClapParameterGesture::Perform, 0));
        for index in 0..PARAMETER_QUEUE_CAPACITY - 1 {
            let expected = match index % 3 {
                0 => ClapParameterGesture::Begin,
                1 => ClapParameterGesture::Perform,
                _ => ClapParameterGesture::End,
            };
            assert_eq!(
                queue.pop(),
                Some((index as u32, index as f64, expected, index as u32))
            );
        }
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn port_buffers_refresh_raw_pointers_and_clone_independent_storage() {
        let mut original = PortBuffer::new(7, 2, 16);
        original.channels[0][0] = 0.25;
        let raw = original.raw();
        assert_eq!(raw.channel_count, 2);
        assert!(!raw.data32.is_null());
        assert!(raw.data64.is_null());

        let mut cloned = original.clone();
        assert_eq!(cloned.id, 7);
        assert_eq!(cloned.channels.len(), 2);
        assert_eq!(cloned.channels[0], vec![0.0; 16]);
        assert_ne!(cloned.raw().data32, raw.data32);
    }

    #[test]
    fn input_event_callbacks_expose_headers_and_guard_invalid_pointers() {
        let mut buffer = InputEventBuffer {
            events: vec![
                InputEvent::Midi(clap_event_midi {
                    header: event_header(size_of::<clap_event_midi>(), 4, CLAP_EVENT_MIDI),
                    port_index: 0,
                    data: [0x90, 60, 100],
                }),
                InputEvent::Gesture(clap_event_param_gesture {
                    header: event_header(
                        size_of::<clap_event_param_gesture>(),
                        8,
                        CLAP_EVENT_PARAM_GESTURE_BEGIN,
                    ),
                    param_id: 3,
                }),
            ],
            sysex: Vec::with_capacity(SYSEX_CAPACITY),
        };
        let list = clap_input_events {
            ctx: (&mut buffer as *mut InputEventBuffer).cast(),
            size: Some(input_event_count),
            get: Some(input_event_get),
        };

        // SAFETY: the list and backing buffer remain live for each callback.
        assert_eq!(unsafe { input_event_count(&list) }, 2);
        // SAFETY: index zero is present and the returned header belongs to the buffer.
        let first = unsafe { input_event_get(&list, 0) };
        assert!(!first.is_null());
        // SAFETY: first points to the live MIDI event header.
        assert_eq!(unsafe { (*first).time }, 4);
        // SAFETY: out-of-range and null list inputs are explicitly supported fallbacks.
        assert!(unsafe { input_event_get(&list, 9) }.is_null());
        // SAFETY: a null list is an explicitly supported fallback.
        assert_eq!(unsafe { input_event_count(std::ptr::null()) }, 0);
        // SAFETY: a null list is an explicitly supported fallback.
        assert!(unsafe { input_event_get(std::ptr::null(), 0) }.is_null());

        let clone = buffer.clone();
        assert!(clone.events.is_empty());
        assert!(clone.sysex.is_empty());
        assert_eq!(clone.events.capacity(), EVENT_CAPACITY);
        assert_eq!(clone.sysex.capacity(), SYSEX_CAPACITY);
    }

    #[test]
    fn output_callback_accepts_values_and_balanced_gestures() {
        let queue = ParameterQueue::new();
        let list = clap_output_events {
            ctx: (&queue as *const ParameterQueue).cast_mut().cast(),
            try_push: Some(push_output_event),
        };
        let value = clap_event_param_value {
            header: event_header(
                size_of::<clap_event_param_value>(),
                5,
                CLAP_EVENT_PARAM_VALUE,
            ),
            param_id: 8,
            cookie: std::ptr::null_mut(),
            note_id: -1,
            port_index: -1,
            channel: -1,
            key: -1,
            value: 0.75,
        };
        let begin = clap_event_param_gesture {
            header: event_header(
                size_of::<clap_event_param_gesture>(),
                2,
                CLAP_EVENT_PARAM_GESTURE_BEGIN,
            ),
            param_id: 8,
        };
        let end = clap_event_param_gesture {
            header: event_header(
                size_of::<clap_event_param_gesture>(),
                7,
                CLAP_EVENT_PARAM_GESTURE_END,
            ),
            param_id: 8,
        };

        // SAFETY: every event has the matching CLAP layout and remains live for the call.
        assert!(unsafe {
            push_output_event(&list, (&begin as *const clap_event_param_gesture).cast())
        });
        // SAFETY: the value event has the matching CLAP layout and remains live for the call.
        assert!(unsafe {
            push_output_event(&list, (&value as *const clap_event_param_value).cast())
        });
        // SAFETY: the end event has the matching CLAP layout and remains live for the call.
        assert!(unsafe {
            push_output_event(&list, (&end as *const clap_event_param_gesture).cast())
        });
        assert_eq!(queue.pop(), Some((8, 0.0, ClapParameterGesture::Begin, 2)));
        assert_eq!(
            queue.pop(),
            Some((8, 0.75, ClapParameterGesture::Perform, 5))
        );
        assert_eq!(queue.pop(), Some((8, 0.0, ClapParameterGesture::End, 7)));

        let mut non_finite = value;
        non_finite.value = f64::NAN;
        // SAFETY: the event layout is valid; the callback must reject its invalid value.
        assert!(!unsafe {
            push_output_event(&list, (&non_finite as *const clap_event_param_value).cast())
        });
        // SAFETY: null pointers are callback fallbacks and never dereferenced.
        assert!(!unsafe { push_output_event(std::ptr::null(), std::ptr::null()) });
    }

    #[test]
    fn transport_maps_timeline_flags_positions_and_bounded_signatures() {
        let context = ProcessContext {
            project_time_samples: 12,
            continuous_time_samples: 13,
            steady_time_samples: 14,
            project_time_quarters: 2.5,
            bar_position_quarters: 2.0,
            tempo: 130.0,
            time_signature_numerator: -4,
            time_signature_denominator: i32::MAX,
            playing: true,
            recording: true,
            loop_active: true,
            loop_start_quarters: 1.0,
            loop_end_quarters: 5.0,
        };
        let event = transport(&context);
        assert_ne!(event.flags & CLAP_TRANSPORT_IS_PLAYING, 0);
        assert_ne!(event.flags & CLAP_TRANSPORT_IS_RECORDING, 0);
        assert_ne!(event.flags & CLAP_TRANSPORT_IS_LOOP_ACTIVE, 0);
        assert_eq!(event.song_pos_beats, fixed(2.5, CLAP_BEATTIME_FACTOR));
        assert_eq!(event.loop_start_beats, fixed(1.0, CLAP_BEATTIME_FACTOR));
        assert_eq!(event.loop_end_beats, fixed(5.0, CLAP_BEATTIME_FACTOR));
        assert_eq!(event.tsig_num, 0);
        assert_eq!(event.tsig_denom, u16::MAX);

        assert_eq!(fixed(f64::INFINITY, 1), i64::MAX);
        assert_eq!(fixed(f64::NEG_INFINITY, 1), i64::MIN);
    }
}
