use std::rc::Rc;

use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Split},
};
use yadaw_vst3_host_sys::{
    Steinberg::{
        IPluginBase,
        Vst::{
            self, AudioBusBuffers, AudioBusBuffers__bindgen_ty_1, BusDirections, DataEvent, Event,
            Event__bindgen_ty_1, IAudioProcessor, IComponent, IProcessContextRequirements,
            NoteOffEvent, NoteOnEvent, PolyPressureEvent, ProcessContext, ProcessData,
            ProcessSetup, SpeakerArrangement,
        },
    },
    abi::{AudioProcessorVTable, ComponentVTable, ProcessContextRequirementsVTable},
    compat::{as_bus_direction, as_int32, as_media_type, as_uint32},
};

use crate::{
    ClassId, ComPtr, HostError, HostResult, Module, event_list::EventList,
    host_context::HostContext, output_parameter_bridge::OutputParameterWriter,
    parameter_changes::ParameterChanges,
};

const MAX_BLOCK_FRAMES: i32 = 4096;

#[cfg(windows)]
const MIDI_SYSEX_DATA_TYPE: u32 = Vst::DataEvent_DataTypes_kMidiSysEx as u32;
#[cfg(not(windows))]
const MIDI_SYSEX_DATA_TYPE: u32 = Vst::DataEvent_DataTypes_kMidiSysEx;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginKind {
    Effect,
    Instrument,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioLayout {
    Mono,
    MonoToStereo,
    Stereo,
}

impl AudioLayout {
    #[must_use]
    pub const fn input_channels(self) -> i32 {
        match self {
            Self::Mono | Self::MonoToStereo => 1,
            Self::Stereo => 2,
        }
    }

    #[must_use]
    pub const fn output_channels(self) -> i32 {
        match self {
            Self::Mono => 1,
            Self::MonoToStereo | Self::Stereo => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HostProcessContext {
    pub project_time_samples: i64,
    pub continuous_time_samples: i64,
    pub project_time_quarters: f64,
    pub bar_position_quarters: f64,
    pub tempo: f64,
    pub time_signature_numerator: i32,
    pub time_signature_denominator: i32,
    pub playing: bool,
    pub recording: bool,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct QueuedParameter {
    pub(crate) id: u32,
    pub(crate) value: f64,
    pub(crate) sample_offset: i32,
}

/// A mono/stereo sample32 VST3 component with explicit lifecycle ownership.
pub struct StereoProcessor {
    processor: ComPtr<IAudioProcessor>,
    component: ComPtr<IComponent>,
    input_events: Box<EventList>,
    input_parameters: Box<ParameterChanges>,
    output_parameters: Box<ParameterChanges>,
    output_parameter_writer: Option<OutputParameterWriter>,
    process_context: Box<ProcessContext>,
    process_context_requirements: u32,
    sample_rate: f64,
    parameter_consumer: HeapCons<QueuedParameter>,
    module: Rc<Module>,
    kind: PluginKind,
    layout: AudioLayout,
    active: bool,
}

impl StereoProcessor {
    pub fn create(
        module: Rc<Module>,
        class_id: ClassId,
        sample_rate: f64,
        kind: PluginKind,
    ) -> HostResult<Self> {
        Self::create_with_layout(module, class_id, sample_rate, kind, AudioLayout::Stereo)
    }

    pub fn create_with_layout(
        module: Rc<Module>,
        class_id: ClassId,
        sample_rate: f64,
        kind: PluginKind,
        layout: AudioLayout,
    ) -> HostResult<Self> {
        Self::create_with_parameter_queue(module, class_id, sample_rate, kind, layout)
            .map(|(processor, _producer)| processor)
    }

    pub(crate) fn create_with_parameter_queue(
        module: Rc<Module>,
        class_id: ClassId,
        sample_rate: f64,
        kind: PluginKind,
        layout: AudioLayout,
    ) -> HostResult<(Self, HeapProd<QueuedParameter>)> {
        let (mut processor, producer, ()) = Self::create_with_parameter_queue_and_hook(
            module,
            class_id,
            sample_rate,
            kind,
            layout,
            |_| Ok(()),
        )?;
        processor.activate()?;
        Ok((processor, producer))
    }

    pub(crate) fn create_with_parameter_queue_and_hook<T>(
        module: Rc<Module>,
        class_id: ClassId,
        sample_rate: f64,
        kind: PluginKind,
        layout: AudioLayout,
        hook: impl FnOnce(*mut std::ffi::c_void) -> HostResult<T>,
    ) -> HostResult<(Self, HeapProd<QueuedParameter>, T)> {
        if kind == PluginKind::Instrument && layout == AudioLayout::MonoToStereo {
            return Err(HostError::Operation {
                operation: "instrument audio layout",
                result: -2147024809,
            });
        }
        let component = module.create::<IComponent>(class_id)?;
        let input_events = EventList::new();
        let input_parameters = ParameterChanges::new();
        let output_parameters = ParameterChanges::new();
        let parameter_ring = HeapRb::new(1024);
        let (parameter_producer, parameter_consumer) = parameter_ring.split();
        let process_context = Box::new(unsafe {
            // SAFETY: VST3 ProcessContext is a plain SDK data structure for which an all-zero
            // value represents no active flags and neutral optional fields.
            std::mem::MaybeUninit::<ProcessContext>::zeroed().assume_init()
        });
        if kind == PluginKind::Instrument {
            check_optional("IComponent::setIoMode(simple)", unsafe {
                // SAFETY: setIoMode is an optional Created-state call made before initialize.
                ((*component_table(&component)).set_io_mode)(
                    component.as_ptr(),
                    as_int32(Vst::IoModes_kSimple),
                )
            })?;
        }
        check("IComponent::initialize", unsafe {
            // SAFETY: component and host are live and owned by this
            // construction path.
            ((*component_table(&component)).base.initialize)(
                component.as_ptr().cast::<IPluginBase>(),
                module.host_context().as_unknown(),
            )
        })?;
        // After initialize(), any failure must terminate before release.
        // Commercial instruments (e.g. Kontakt) crash in their destructors when
        // the host skips terminate on the error path.
        let mut lifecycle = InitializedComponent::new(component);
        let hook_result = hook(lifecycle.component().as_ptr().cast())?;
        let processor = lifecycle.component().query::<IAudioProcessor>()?;
        lifecycle.set_processor(processor);
        let (component, processor) = lifecycle.take();
        Ok((
            Self {
                processor,
                component,
                input_events,
                input_parameters,
                output_parameters,
                output_parameter_writer: None,
                process_context,
                process_context_requirements: 0,
                sample_rate,
                parameter_consumer,
                module,
                kind,
                layout,
                active: false,
            },
            parameter_producer,
            hook_result,
        ))
    }

    /// Completes capability negotiation and enters the VST3 active/processing states.
    /// Controller handlers and connection points must be installed before this call.
    pub(crate) fn activate(&mut self) -> HostResult<()> {
        if self.active {
            return Ok(());
        }
        self.process_context_requirements = self
            .processor
            .query::<IProcessContextRequirements>()
            .ok()
            .map_or_else(legacy_process_context_requirements, |requirements| unsafe {
                // SAFETY: requirements is a live extension queried from the initialized processor.
                ((*process_context_requirements_table(&requirements))
                    .get_process_context_requirements)(requirements.as_ptr())
            });
        let processor_table = processor_table(&self.processor);
        let component_table = component_table(&self.component);
        check("canProcessSampleSize(sample32)", unsafe {
            // SAFETY: processor is initialized and live.
            ((*processor_table).can_process_sample_size)(
                self.processor.as_ptr(),
                as_int32(Vst::SymbolicSampleSizes_kSample32),
            )
        })?;
        negotiate_bus_arrangements(&self.component, &self.processor, self.layout)?;
        if self.kind == PluginKind::Effect {
            check("activate audio input", unsafe {
                // SAFETY: component is initialized; bus zero is the negotiated main input.
                ((*component_table).activate_bus)(
                    self.component.as_ptr(),
                    as_media_type(Vst::MediaTypes_kAudio),
                    as_bus_direction(Vst::BusDirections_kInput),
                    0,
                    1,
                )
            })?;
        }
        check("activate audio output", unsafe {
            // SAFETY: component is initialized; bus zero is the negotiated main output.
            ((*component_table).activate_bus)(
                self.component.as_ptr(),
                as_media_type(Vst::MediaTypes_kAudio),
                as_bus_direction(Vst::BusDirections_kOutput),
                0,
                1,
            )
        })?;
        activate_event_input_buses(&self.component)?;
        let mut setup = ProcessSetup {
            processMode: as_int32(Vst::ProcessModes_kRealtime),
            symbolicSampleSize: as_int32(Vst::SymbolicSampleSizes_kSample32),
            maxSamplesPerBlock: MAX_BLOCK_FRAMES,
            sampleRate: self.sample_rate,
        };
        check("setupProcessing", unsafe {
            // SAFETY: setup is initialized and valid for this call.
            ((*processor_table).setup_processing)(
                self.processor.as_ptr(),
                std::ptr::addr_of_mut!(setup),
            )
        })?;
        check("setActive(true)", unsafe {
            // SAFETY: all buses and processing configuration are set.
            ((*component_table).set_active)(self.component.as_ptr(), 1)
        })?;
        self.active = true;
        check_optional("setProcessing(true)", unsafe {
            // SAFETY: component is active.
            ((*processor_table).set_processing)(self.processor.as_ptr(), 1)
        })?;
        Ok(())
    }

    pub(crate) fn restart_processing(&mut self) -> HostResult<()> {
        if self.active {
            unsafe {
                // SAFETY: processing and activation are stopped in reverse order on the UI thread.
                ((*processor_table(&self.processor)).set_processing)(self.processor.as_ptr(), 0);
                ((*component_table(&self.component)).set_active)(self.component.as_ptr(), 0);
            }
            self.active = false;
        }
        self.activate()
    }

    #[must_use]
    pub fn kind(&self) -> PluginKind {
        self.kind
    }

    #[must_use]
    pub fn layout(&self) -> AudioLayout {
        self.layout
    }

    #[must_use]
    pub fn latency_samples(&self) -> u32 {
        let table = processor_table(&self.processor);
        unsafe {
            // SAFETY: processor remains live.
            ((*table).latency_samples)(self.processor.as_ptr())
        }
    }

    #[must_use]
    pub fn tail_samples(&self) -> Option<u32> {
        let table = processor_table(&self.processor);
        let value = unsafe {
            // SAFETY: processor remains live.
            ((*table).tail_samples)(self.processor.as_ptr())
        };
        (value != Vst::kInfiniteTail).then_some(value)
    }

    pub fn process_stereo(
        &mut self,
        input_left: &mut [f32],
        input_right: &mut [f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) -> HostResult<()> {
        self.process_stereo_with_context(input_left, input_right, output_left, output_right, None)
    }

    pub fn process_stereo_with_context(
        &mut self,
        input_left: &mut [f32],
        input_right: &mut [f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
        context: Option<&HostProcessContext>,
    ) -> HostResult<()> {
        let frames = input_left.len();
        if frames > MAX_BLOCK_FRAMES as usize
            || input_right.len() != frames
            || output_left.len() != frames
            || output_right.len() != frames
        {
            return Err(HostError::Operation {
                operation: "process block shape",
                result: -2147024809,
            });
        }
        let mut input_channels = [input_left.as_mut_ptr(), input_right.as_mut_ptr()];
        let mut output_channels = [output_left.as_mut_ptr(), output_right.as_mut_ptr()];
        let mut input_bus = AudioBusBuffers {
            numChannels: self.layout.input_channels(),
            silenceFlags: 0,
            __bindgen_anon_1: AudioBusBuffers__bindgen_ty_1 {
                channelBuffers32: input_channels.as_mut_ptr(),
            },
        };
        let mut output_bus = AudioBusBuffers {
            numChannels: self.layout.output_channels(),
            silenceFlags: 0,
            __bindgen_anon_1: AudioBusBuffers__bindgen_ty_1 {
                channelBuffers32: output_channels.as_mut_ptr(),
            },
        };
        let event_list = (!self.input_events.is_empty()).then(|| self.input_events.as_interface());
        while let Some(parameter) = self.parameter_consumer.try_pop() {
            let _ = self.input_parameters.add_value(
                parameter.id,
                parameter.sample_offset,
                parameter.value,
            );
        }
        self.output_parameters.clear();
        let parameter_changes = self.input_parameters.as_interface();
        let output_parameter_changes = self.output_parameters.as_interface();
        let process_context = context.map(|context| {
            let value = &mut self.process_context;
            update_process_context(
                value,
                self.process_context_requirements,
                self.sample_rate,
                context,
            );
            std::ptr::from_mut(value.as_mut())
        });
        let mut data = ProcessData {
            processMode: as_int32(Vst::ProcessModes_kRealtime),
            symbolicSampleSize: as_int32(Vst::SymbolicSampleSizes_kSample32),
            numSamples: frames as i32,
            numInputs: i32::from(self.kind == PluginKind::Effect),
            numOutputs: 1,
            inputs: if self.kind == PluginKind::Effect {
                std::ptr::addr_of_mut!(input_bus)
            } else {
                std::ptr::null_mut()
            },
            outputs: std::ptr::addr_of_mut!(output_bus),
            inputParameterChanges: parameter_changes,
            outputParameterChanges: output_parameter_changes,
            inputEvents: event_list.unwrap_or(std::ptr::null_mut()),
            outputEvents: std::ptr::null_mut(),
            processContext: process_context.unwrap_or(std::ptr::null_mut()),
        };
        let result = check("process", unsafe {
            // SAFETY: all channel arrays and ProcessData storage remain
            // valid and uniquely borrowed for the duration of the call.
            ((*processor_table(&self.processor)).process)(
                self.processor.as_ptr(),
                std::ptr::addr_of_mut!(data),
            )
        });
        if result.is_ok() {
            self.publish_output_parameters();
        }
        self.input_events.clear();
        self.input_parameters.clear();
        self.output_parameters.clear();
        result
    }

    pub(crate) fn component(&self) -> &ComPtr<IComponent> {
        &self.component
    }

    pub(crate) fn set_output_parameter_writer(&mut self, writer: OutputParameterWriter) {
        self.output_parameter_writer = Some(writer);
    }

    pub(crate) fn host(&self) -> &HostContext {
        self.module.host_context()
    }

    pub(crate) fn flush_parameters(&mut self) -> HostResult<()> {
        self.input_parameters.clear();
        while let Some(parameter) = self.parameter_consumer.try_pop() {
            let _ = self.input_parameters.add_value(
                parameter.id,
                parameter.sample_offset,
                parameter.value,
            );
        }
        self.output_parameters.clear();
        let mut data = ProcessData {
            processMode: as_int32(Vst::ProcessModes_kRealtime),
            symbolicSampleSize: as_int32(Vst::SymbolicSampleSizes_kSample32),
            numSamples: 0,
            numInputs: 0,
            numOutputs: 0,
            inputs: std::ptr::null_mut(),
            outputs: std::ptr::null_mut(),
            inputParameterChanges: self.input_parameters.as_interface(),
            outputParameterChanges: self.output_parameters.as_interface(),
            inputEvents: std::ptr::null_mut(),
            outputEvents: std::ptr::null_mut(),
            processContext: std::ptr::null_mut(),
        };
        let result = check("process(parameter flush)", unsafe {
            // SAFETY: zero-sample ProcessData contains live parameter interfaces and no buffers.
            ((*processor_table(&self.processor)).process)(
                self.processor.as_ptr(),
                std::ptr::addr_of_mut!(data),
            )
        });
        if result.is_ok() {
            self.publish_output_parameters();
        }
        self.input_parameters.clear();
        self.output_parameters.clear();
        result
    }

    fn publish_output_parameters(&self) {
        let Some(writer) = &self.output_parameter_writer else {
            return;
        };
        self.output_parameters.for_each_last(|id, value| {
            let _ = writer.publish(id, value);
        });
    }

    pub fn queue_note_on(
        &mut self,
        sample_offset: i32,
        channel: i16,
        pitch: i16,
        velocity: f32,
        note_id: i32,
    ) -> bool {
        self.input_events.push(Event {
            busIndex: 0,
            sampleOffset: sample_offset,
            ppqPosition: 0.0,
            flags: 0,
            type_: Vst::Event_EventTypes_kNoteOnEvent as u16,
            __bindgen_anon_1: Event__bindgen_ty_1 {
                noteOn: NoteOnEvent {
                    channel,
                    pitch,
                    tuning: 0.0,
                    velocity: velocity.clamp(0.0, 1.0),
                    length: 0,
                    noteId: note_id,
                },
            },
        })
    }

    pub fn queue_note_off(
        &mut self,
        sample_offset: i32,
        channel: i16,
        pitch: i16,
        velocity: f32,
        note_id: i32,
    ) -> bool {
        self.input_events.push(Event {
            busIndex: 0,
            sampleOffset: sample_offset,
            ppqPosition: 0.0,
            flags: 0,
            type_: Vst::Event_EventTypes_kNoteOffEvent as u16,
            __bindgen_anon_1: Event__bindgen_ty_1 {
                noteOff: NoteOffEvent {
                    channel,
                    pitch,
                    velocity: velocity.clamp(0.0, 1.0),
                    noteId: note_id,
                    tuning: 0.0,
                },
            },
        })
    }

    pub fn queue_poly_pressure(
        &mut self,
        sample_offset: i32,
        channel: i16,
        pitch: i16,
        pressure: f32,
    ) -> bool {
        self.input_events.push(Event {
            busIndex: 0,
            sampleOffset: sample_offset,
            ppqPosition: 0.0,
            flags: 0,
            type_: Vst::Event_EventTypes_kPolyPressureEvent as u16,
            __bindgen_anon_1: Event__bindgen_ty_1 {
                polyPressure: PolyPressureEvent {
                    channel,
                    pitch,
                    pressure: pressure.clamp(0.0, 1.0),
                    noteId: -1,
                },
            },
        })
    }

    pub fn queue_sysex(&mut self, sample_offset: i32, bytes: &[u8]) -> bool {
        let Ok(size) = u32::try_from(bytes.len()) else {
            return false;
        };
        self.input_events.push(Event {
            busIndex: 0,
            sampleOffset: sample_offset,
            ppqPosition: 0.0,
            flags: 0,
            type_: Vst::Event_EventTypes_kDataEvent as u16,
            __bindgen_anon_1: Event__bindgen_ty_1 {
                data: DataEvent {
                    size,
                    type_: MIDI_SYSEX_DATA_TYPE,
                    bytes: bytes.as_ptr(),
                },
            },
        })
    }

    pub fn queue_parameter_change(
        &mut self,
        sample_offset: i32,
        parameter_id: u32,
        value: f64,
    ) -> bool {
        self.input_parameters
            .add_value(parameter_id, sample_offset, value.clamp(0.0, 1.0))
    }
}

impl Drop for StereoProcessor {
    fn drop(&mut self) {
        let component_table = component_table(&self.component);
        if self.active {
            let processor_table = processor_table(&self.processor);
            unsafe {
                // SAFETY: lifecycle teardown is performed once in reverse
                // activation order while all interfaces and the module live.
                ((*processor_table).set_processing)(self.processor.as_ptr(), 0);
                ((*component_table).set_active)(self.component.as_ptr(), 0);
            }
            self.active = false;
        }
        unsafe {
            // SAFETY: every StereoProcessor owns one successfully initialized component.
            ((*component_table).base.terminate)(self.component.as_ptr().cast::<IPluginBase>());
        }
        let _keep_alive = &self.module;
    }
}

fn legacy_process_context_requirements() -> u32 {
    Vst::IProcessContextRequirements_Flags_kNeedContinousTimeSamples
        | Vst::IProcessContextRequirements_Flags_kNeedProjectTimeMusic
        | Vst::IProcessContextRequirements_Flags_kNeedBarPositionMusic
        | Vst::IProcessContextRequirements_Flags_kNeedTempo
        | Vst::IProcessContextRequirements_Flags_kNeedTimeSignature
        | Vst::IProcessContextRequirements_Flags_kNeedTransportState
}

fn requirement_enabled(requirements: u32, flag: u32) -> bool {
    requirements & flag != 0
}

fn supported_process_context_state(requirements: u32) -> u32 {
    let mut state = 0;
    if requirement_enabled(
        requirements,
        Vst::IProcessContextRequirements_Flags_kNeedContinousTimeSamples,
    ) {
        state |= as_uint32(Vst::ProcessContext_StatesAndFlags_kContTimeValid);
    }
    if requirement_enabled(
        requirements,
        Vst::IProcessContextRequirements_Flags_kNeedProjectTimeMusic,
    ) {
        state |= as_uint32(Vst::ProcessContext_StatesAndFlags_kProjectTimeMusicValid);
    }
    if requirement_enabled(
        requirements,
        Vst::IProcessContextRequirements_Flags_kNeedBarPositionMusic,
    ) {
        state |= as_uint32(Vst::ProcessContext_StatesAndFlags_kBarPositionValid);
    }
    if requirement_enabled(
        requirements,
        Vst::IProcessContextRequirements_Flags_kNeedTempo,
    ) {
        state |= as_uint32(Vst::ProcessContext_StatesAndFlags_kTempoValid);
    }
    if requirement_enabled(
        requirements,
        Vst::IProcessContextRequirements_Flags_kNeedTimeSignature,
    ) {
        state |= as_uint32(Vst::ProcessContext_StatesAndFlags_kTimeSigValid);
    }
    state
}

fn update_process_context(
    value: &mut ProcessContext,
    requirements: u32,
    sample_rate: f64,
    context: &HostProcessContext,
) {
    value.state = supported_process_context_state(requirements);
    value.sampleRate = sample_rate;
    if requirement_enabled(
        requirements,
        Vst::IProcessContextRequirements_Flags_kNeedTransportState,
    ) && context.playing
    {
        value.state |= as_uint32(Vst::ProcessContext_StatesAndFlags_kPlaying);
    }
    if requirement_enabled(
        requirements,
        Vst::IProcessContextRequirements_Flags_kNeedTransportState,
    ) && context.recording
    {
        value.state |= as_uint32(Vst::ProcessContext_StatesAndFlags_kRecording);
    }
    value.projectTimeSamples = context.project_time_samples;
    value.continousTimeSamples = context.continuous_time_samples;
    value.projectTimeMusic = context.project_time_quarters;
    value.barPositionMusic = context.bar_position_quarters;
    value.tempo = context.tempo;
    value.timeSigNumerator = context.time_signature_numerator;
    value.timeSigDenominator = context.time_signature_denominator;
}

/// Owns an initialized VST3 component until construction succeeds or fails.
///
/// On failure, tears down with `setProcessing(false)` / `setActive(false)` /
/// `terminate()` before `ComPtr` release. Skipping `terminate()` after a
/// successful `initialize()` crashes some commercial instruments (Kontakt).
struct InitializedComponent {
    component: Option<ComPtr<IComponent>>,
    processor: Option<ComPtr<IAudioProcessor>>,
    active: bool,
    processing: bool,
}

impl InitializedComponent {
    fn new(component: ComPtr<IComponent>) -> Self {
        Self {
            component: Some(component),
            processor: None,
            active: false,
            processing: false,
        }
    }

    fn component(&self) -> &ComPtr<IComponent> {
        self.component
            .as_ref()
            .expect("initialized component is present until take()")
    }

    fn set_processor(&mut self, processor: ComPtr<IAudioProcessor>) {
        self.processor = Some(processor);
    }

    fn take(mut self) -> (ComPtr<IComponent>, ComPtr<IAudioProcessor>) {
        let component = self
            .component
            .take()
            .expect("initialized component is present until take()");
        let processor = self
            .processor
            .take()
            .expect("audio processor is present until take()");
        // Disarm Drop so StereoProcessor owns the remaining lifecycle.
        self.active = false;
        self.processing = false;
        (component, processor)
    }
}

impl Drop for InitializedComponent {
    fn drop(&mut self) {
        let Some(component) = self.component.as_ref() else {
            return;
        };
        let component_table = component_table(component);
        unsafe {
            // SAFETY: component was successfully initialized; tear down in reverse
            // activation order while the module and interfaces remain live.
            if self.processing
                && let Some(processor) = self.processor.as_ref()
            {
                ((*processor_table(processor)).set_processing)(processor.as_ptr(), 0);
            }
            if self.active {
                ((*component_table).set_active)(component.as_ptr(), 0);
            }
            ((*component_table).base.terminate)(component.as_ptr().cast::<IPluginBase>());
        }
    }
}

fn audio_bus_count(component: &ComPtr<IComponent>, direction: BusDirections) -> i32 {
    let component_table = component_table(component);
    unsafe {
        // SAFETY: component is initialized and the media/direction enums are SDK values.
        ((*component_table).get_bus_count)(
            component.as_ptr(),
            as_media_type(Vst::MediaTypes_kAudio),
            as_bus_direction(direction),
        )
    }
    .max(0)
}

fn bus_arrangement(
    processor: &ComPtr<IAudioProcessor>,
    direction: BusDirections,
    index: i32,
) -> HostResult<SpeakerArrangement> {
    let mut arrangement = 0;
    check("getBusArrangement", unsafe {
        // SAFETY: arrangement points to writable SDK storage for this call.
        ((*processor_table(processor)).get_bus_arrangement)(
            processor.as_ptr(),
            as_bus_direction(direction),
            index,
            std::ptr::addr_of_mut!(arrangement),
        )
    })?;
    Ok(arrangement)
}

fn bus_arrangement_or(
    processor: &ComPtr<IAudioProcessor>,
    direction: BusDirections,
    index: i32,
    fallback: SpeakerArrangement,
) -> SpeakerArrangement {
    bus_arrangement(processor, direction, index).unwrap_or(fallback)
}

/// Negotiate speaker arrangements the way Steinberg hosts do:
/// propose layouts for every audio bus (`getBusCount`), treat `kResultFalse`
/// as a counter-offer, then adopt the plug-in's `getBusArrangement` values.
///
/// Multi-out instruments (Kontakt) reject a single-bus proposal; passing the
/// full bus count lets them adapt while we still only activate the main out.
fn negotiate_bus_arrangements(
    component: &ComPtr<IComponent>,
    processor: &ComPtr<IAudioProcessor>,
    layout: AudioLayout,
) -> HostResult<()> {
    let input_count = audio_bus_count(component, Vst::BusDirections_kInput) as usize;
    let output_count = audio_bus_count(component, Vst::BusDirections_kOutput) as usize;
    if output_count == 0 {
        return Err(HostError::Operation {
            operation: "audio output bus count",
            result: -2147024809,
        });
    }

    let desired_main = if layout.output_channels() == 1 {
        Vst::SpeakerArr::kMono
    } else {
        Vst::SpeakerArr::kStereo
    };
    let desired_input = if layout.input_channels() == 1 {
        Vst::SpeakerArr::kMono
    } else {
        Vst::SpeakerArr::kStereo
    };

    let mut inputs = (0..input_count)
        .map(|index| {
            if index == 0 {
                desired_input
            } else {
                bus_arrangement_or(
                    processor,
                    Vst::BusDirections_kInput,
                    index as i32,
                    Vst::SpeakerArr::kStereo,
                )
            }
        })
        .collect::<Vec<_>>();
    let mut outputs = (0..output_count)
        .map(|index| {
            if index == 0 {
                desired_main
            } else {
                bus_arrangement_or(
                    processor,
                    Vst::BusDirections_kOutput,
                    index as i32,
                    Vst::SpeakerArr::kStereo,
                )
            }
        })
        .collect::<Vec<_>>();

    let processor_table = processor_table(processor);
    let result = unsafe {
        // SAFETY: input/output arrangement arrays stay live for the call and
        // lengths match IComponent::getBusCount for each direction.
        ((*processor_table).set_bus_arrangements)(
            processor.as_ptr(),
            if inputs.is_empty() {
                std::ptr::null_mut()
            } else {
                inputs.as_mut_ptr()
            },
            inputs.len() as i32,
            outputs.as_mut_ptr(),
            outputs.len() as i32,
        )
    };
    // kResultOk / kResultTrue == 0: accepted as proposed.
    if result == 0 {
        return Ok(());
    }
    // kResultFalse == 1: plug-in rejected the proposal but may have adapted.
    // Read back every bus and continue — matching Cubase/Logic negotiation.
    if result != 1 {
        return Err(HostError::Operation {
            operation: "setBusArrangements",
            result,
        });
    }

    for (index, arrangement) in inputs.iter_mut().enumerate() {
        *arrangement = bus_arrangement(processor, Vst::BusDirections_kInput, index as i32)?;
    }
    for (index, arrangement) in outputs.iter_mut().enumerate() {
        *arrangement = bus_arrangement(processor, Vst::BusDirections_kOutput, index as i32)?;
    }

    let confirm = unsafe {
        // SAFETY: same as the proposal call; arrays still match getBusCount.
        ((*processor_table).set_bus_arrangements)(
            processor.as_ptr(),
            if inputs.is_empty() {
                std::ptr::null_mut()
            } else {
                inputs.as_mut_ptr()
            },
            inputs.len() as i32,
            outputs.as_mut_ptr(),
            outputs.len() as i32,
        )
    };
    // After adopting the plug-in's arrangements, either Ok or False is fine —
    // Steinberg's reject workflow proceeds to setActive after getBusArrangement.
    if confirm == 0 || confirm == 1 {
        Ok(())
    } else {
        Err(HostError::Operation {
            operation: "setBusArrangements",
            result: confirm,
        })
    }
}

fn activate_event_input_buses(component: &ComPtr<IComponent>) -> HostResult<()> {
    let component_table = component_table(component);
    let count = unsafe {
        // SAFETY: component is initialized and the media/direction enums are SDK values.
        ((*component_table).get_bus_count)(
            component.as_ptr(),
            as_media_type(Vst::MediaTypes_kEvent),
            as_bus_direction(Vst::BusDirections_kInput),
        )
    }
    .max(0);
    for index in 0..count {
        check("activate event input", unsafe {
            // SAFETY: index is within getBusCount(kEvent, kInput).
            ((*component_table).activate_bus)(
                component.as_ptr(),
                as_media_type(Vst::MediaTypes_kEvent),
                as_bus_direction(Vst::BusDirections_kInput),
                index,
                1,
            )
        })?;
    }
    Ok(())
}

fn component_table(component: &ComPtr<IComponent>) -> *const ComponentVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *component.as_ptr().cast::<*const ComponentVTable>()
    }
}

fn processor_table(processor: &ComPtr<IAudioProcessor>) -> *const AudioProcessorVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *processor.as_ptr().cast::<*const AudioProcessorVTable>()
    }
}

fn process_context_requirements_table(
    requirements: &ComPtr<IProcessContextRequirements>,
) -> *const ProcessContextRequirementsVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *requirements
            .as_ptr()
            .cast::<*const ProcessContextRequirementsVTable>()
    }
}

fn check(operation: &'static str, result: i32) -> HostResult<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(HostError::Operation { operation, result })
    }
}

fn check_optional(operation: &'static str, result: i32) -> HostResult<()> {
    // Valid components may inherit the default kNotImplemented
    // setProcessing implementation. setupProcessing plus setActive still
    // establishes a legal processing lifecycle in that case.
    if result == 0 || result == 1 || result == -2147467263 {
        Ok(())
    } else {
        Err(HostError::Operation { operation, result })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use yadaw_vst3_host_sys::Steinberg::Vst;

    #[test]
    fn audio_layouts_report_their_input_and_output_channel_contracts() {
        assert_eq!(AudioLayout::Mono.input_channels(), 1);
        assert_eq!(AudioLayout::Mono.output_channels(), 1);
        assert_eq!(AudioLayout::MonoToStereo.input_channels(), 1);
        assert_eq!(AudioLayout::MonoToStereo.output_channels(), 2);
        assert_eq!(AudioLayout::Stereo.input_channels(), 2);
        assert_eq!(AudioLayout::Stereo.output_channels(), 2);
    }

    #[test]
    fn optional_vst3_operations_accept_not_implemented_only() {
        assert!(check_optional("setProcessing", 0).is_ok());
        assert!(check_optional("setProcessing", -2147467263).is_ok());
        assert!(matches!(
            check_optional("setProcessing", -1),
            Err(HostError::Operation {
                operation: "setProcessing",
                result: -1,
            })
        ));
        assert!(matches!(
            check("setupProcessing", -2),
            Err(HostError::Operation {
                operation: "setupProcessing",
                result: -2,
            })
        ));
    #[test]
    fn process_context_uses_real_sample_rate_and_only_requested_validity_bits() {
        let mut value = unsafe {
            // SAFETY: ProcessContext is an SDK POD and zero is a valid empty context.
            std::mem::MaybeUninit::<ProcessContext>::zeroed().assume_init()
        };
        let requirements = Vst::IProcessContextRequirements_Flags_kNeedTempo;
        update_process_context(
            &mut value,
            requirements,
            96_000.0,
            &HostProcessContext {
                project_time_samples: 12,
                continuous_time_samples: 13,
                project_time_quarters: 1.0,
                bar_position_quarters: 0.0,
                tempo: 127.0,
                time_signature_numerator: 7,
                time_signature_denominator: 8,
                playing: true,
                recording: true,
            },
        );
        assert_eq!(value.sampleRate, 96_000.0);
        assert_eq!(
            value.state,
            as_uint32(Vst::ProcessContext_StatesAndFlags_kTempoValid)
        );
        assert_eq!(value.tempo, 127.0);
    }
}
