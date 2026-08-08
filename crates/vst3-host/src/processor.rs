use std::rc::Rc;

use heron_vst3_host_sys::{
    Steinberg::{
        IPluginBase,
        Vst::{
            self, AudioBusBuffers, DataEvent, Event, Event__bindgen_ty_1,
            IAudioPresentationLatency, IAudioProcessor, IComponent, IProcessContextRequirements,
            NoteOffEvent, NoteOnEvent, PolyPressureEvent, ProcessContext, ProcessData,
            ProcessSetup,
        },
    },
    compat::{
        BindgenEnum, as_bus_direction, as_int32, as_media_type, as_uint32, combine_uint32_flags,
    },
};
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Split},
};

use crate::{
    ClassId, ComPtr, HostError, HostResult, Module, event_list::EventList,
    host_context::HostContext, output_parameter_bridge::OutputParameterWriter,
    parameter_changes::ParameterChanges,
};

mod buses;

use buses::{
    InitializedComponent, activate_event_input_buses, apply_bus_activation_overrides,
    audio_bus_count, audio_bus_descriptors, audio_bus_is_active, check, check_optional,
    component_table, configure_audio_bus_activation, negotiate_bus_arrangements,
    prepare_audio_bus_storage, presentation_latency_table, process_context_requirements_table,
    processor_table, silence_flags, validate_bus_address, validate_main_bus_layout,
};

#[cfg(test)]
use buses::build_audio_bus_storage;

const MAX_BLOCK_FRAMES: i32 = 4096;

/// VST3 reserves note identifiers from -10000 through -1000 for plug-in use.
/// MIDI 1.0 input does not carry a note identifier, so normalize every host
/// value below the SDK's "not available" sentinel to -1 at the FFI boundary.
const fn vst3_note_id(note_id: i32) -> i32 {
    if note_id < -1 { -1 } else { note_id }
}

#[inline]
fn midi_sysex_data_type() -> u32 {
    as_uint32(Vst::DataEvent_DataTypes_kMidiSysEx)
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioBusDirection {
    Input,
    Output,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioBusKind {
    Main,
    Aux,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioBusDescriptor {
    pub index: i32,
    pub direction: AudioBusDirection,
    pub kind: AudioBusKind,
    pub name: String,
    pub channels: i32,
    pub default_active: bool,
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

struct AudioBusStorage {
    descriptors: Vec<AudioBusBuffers>,
    channel_pointers: Vec<Vec<*mut f32>>,
    scratch: Vec<Vec<f32>>,
    input: bool,
}

#[derive(Clone)]
pub(crate) struct AuxiliaryAudioInput {
    pub(crate) bus_index: usize,
    pub(crate) channels: u8,
    pub(crate) left: Vec<f32>,
    pub(crate) right: Vec<f32>,
}

impl AudioBusStorage {
    const fn empty(input: bool) -> Self {
        Self {
            descriptors: Vec::new(),
            channel_pointers: Vec::new(),
            scratch: Vec::new(),
            input,
        }
    }

    fn connect_main(&mut self, channels: &mut [*mut f32]) {
        self.channel_pointers[0].copy_from_slice(channels);
        self.descriptors[0].silenceFlags = 0;
    }

    fn disconnect_main(&mut self) {
        let scratch = self.scratch[0].as_mut_ptr();
        for (channel, pointer) in self.channel_pointers[0].iter_mut().enumerate() {
            *pointer = unsafe {
                // SAFETY: every bus scratch allocation contains MAX_BLOCK_FRAMES
                // samples for each channel in its matching pointer array.
                scratch.add(channel * MAX_BLOCK_FRAMES as usize)
            };
        }
        self.descriptors[0].silenceFlags = if self.input {
            silence_flags(self.channel_pointers[0].len())
        } else {
            0
        };
    }

    fn connect_aux(&mut self, input: &AuxiliaryAudioInput, frames: usize) -> HostResult<()> {
        let Some(descriptor) = self.descriptors.get_mut(input.bus_index) else {
            return Err(HostError::Operation {
                operation: "aux audio input bus index",
                result: -2147024809,
            });
        };
        let Some(pointers) = self.channel_pointers.get_mut(input.bus_index) else {
            return Err(HostError::Operation {
                operation: "aux audio input bus storage",
                result: -2147024809,
            });
        };
        let channels = usize::from(input.channels);
        if channels != pointers.len()
            || input.left.len() < frames
            || (channels == 2 && input.right.len() < frames)
        {
            return Err(HostError::Operation {
                operation: "aux audio input block shape",
                result: -2147024809,
            });
        }
        pointers[0] = input.left.as_ptr().cast_mut();
        if channels == 2 {
            pointers[1] = input.right.as_ptr().cast_mut();
        }
        descriptor.silenceFlags = 0;
        Ok(())
    }

    fn disconnect_bus(&mut self, bus_index: usize) {
        let Some(pointers) = self.channel_pointers.get_mut(bus_index) else {
            return;
        };
        let scratch = self.scratch[bus_index].as_mut_ptr();
        for (channel, pointer) in pointers.iter_mut().enumerate() {
            *pointer = unsafe {
                // SAFETY: every bus scratch allocation contains MAX_BLOCK_FRAMES per channel.
                scratch.add(channel * MAX_BLOCK_FRAMES as usize)
            };
        }
        self.descriptors[bus_index].silenceFlags = silence_flags(pointers.len());
    }
}

/// A mono/stereo sample32 VST3 component with explicit lifecycle ownership.
pub struct StereoProcessor {
    processor: ComPtr<IAudioProcessor>,
    presentation_latency: Option<ComPtr<IAudioPresentationLatency>>,
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
    audio_input_buses: AudioBusStorage,
    audio_output_buses: AudioBusStorage,
    bus_activation_overrides: Vec<BusActivationOverride>,
    input_presentation_latency_samples: u32,
    output_presentation_latency_samples: u32,
    active: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BusActivationOverride {
    media_type: i32,
    direction: i32,
    index: i32,
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
        let presentation_latency = processor.query::<IAudioPresentationLatency>().ok();
        Ok((
            Self {
                processor,
                presentation_latency,
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
                audio_input_buses: AudioBusStorage::empty(true),
                audio_output_buses: AudioBusStorage::empty(false),
                bus_activation_overrides: Vec::new(),
                input_presentation_latency_samples: 0,
                output_presentation_latency_samples: 0,
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
        configure_audio_bus_activation(&self.component, self.kind)?;
        self.audio_input_buses =
            prepare_audio_bus_storage(&self.component, Vst::BusDirections_kInput)?;
        self.audio_output_buses =
            prepare_audio_bus_storage(&self.component, Vst::BusDirections_kOutput)?;
        validate_main_bus_layout(
            &self.audio_input_buses,
            &self.audio_output_buses,
            self.kind,
            self.layout,
        )?;
        activate_event_input_buses(&self.component)?;
        apply_bus_activation_overrides(&self.component, &self.bus_activation_overrides)?;
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
        self.apply_presentation_latency()?;
        check_optional("setProcessing(true)", unsafe {
            // SAFETY: component is active.
            ((*processor_table).set_processing)(self.processor.as_ptr(), 1)
        })?;
        Ok(())
    }

    pub(crate) fn restart_processing(&mut self) -> HostResult<()> {
        self.deactivate()?;
        self.activate()
    }

    pub(crate) fn set_bus_active(
        &mut self,
        media_type: i32,
        direction: i32,
        index: i32,
        active: bool,
    ) -> HostResult<()> {
        validate_bus_address(&self.component, media_type, direction, index)?;
        if let Some(existing) = self.bus_activation_overrides.iter_mut().find(|entry| {
            entry.media_type == media_type && entry.direction == direction && entry.index == index
        }) {
            existing.active = active;
        } else {
            self.bus_activation_overrides.push(BusActivationOverride {
                media_type,
                direction,
                index,
                active,
            });
        }
        self.restart_processing()
    }

    pub(crate) fn configure_aux_input_buses(&mut self, indices: &[u32]) -> HostResult<()> {
        if self.active {
            return Err(HostError::Operation {
                operation: "configure aux audio inputs before activation",
                result: -2147024809,
            });
        }
        for &index in indices {
            let index = i32::try_from(index).map_err(|_| HostError::Operation {
                operation: "aux audio input bus index",
                result: -2147024809,
            })?;
            validate_bus_address(
                &self.component,
                as_media_type(Vst::MediaTypes_kAudio),
                as_bus_direction(Vst::BusDirections_kInput),
                index,
            )?;
            self.bus_activation_overrides.push(BusActivationOverride {
                media_type: as_media_type(Vst::MediaTypes_kAudio),
                direction: as_bus_direction(Vst::BusDirections_kInput),
                index,
                active: true,
            });
        }
        Ok(())
    }

    pub(crate) fn set_presentation_latency(
        &mut self,
        input_samples: u32,
        output_samples: u32,
    ) -> HostResult<()> {
        if self.input_presentation_latency_samples == input_samples
            && self.output_presentation_latency_samples == output_samples
        {
            return Ok(());
        }
        let previous_input = self.input_presentation_latency_samples;
        let previous_output = self.output_presentation_latency_samples;
        self.input_presentation_latency_samples = input_samples;
        self.output_presentation_latency_samples = output_samples;
        if self.active
            && let Err(error) = self.apply_presentation_latency()
        {
            self.input_presentation_latency_samples = previous_input;
            self.output_presentation_latency_samples = previous_output;
            return Err(error);
        }
        Ok(())
    }

    fn apply_presentation_latency(&self) -> HostResult<()> {
        let Some(interface) = &self.presentation_latency else {
            return Ok(());
        };
        let table = presentation_latency_table(interface);
        for direction in [Vst::BusDirections_kInput, Vst::BusDirections_kOutput] {
            let count = audio_bus_count(&self.component, direction);
            let latency = if direction == Vst::BusDirections_kInput {
                self.input_presentation_latency_samples
            } else {
                self.output_presentation_latency_samples
            };
            for index in 0..count {
                if !audio_bus_is_active(self.kind, direction, index, &self.bus_activation_overrides)
                {
                    continue;
                }
                check(
                    "IAudioPresentationLatency::setAudioPresentationLatencySamples",
                    unsafe {
                        // SAFETY: the interface and component are activated, and index identifies an
                        // active audio bus returned by IComponent::getBusCount.
                        ((*table).set_audio_presentation_latency_samples)(
                            interface.as_ptr(),
                            as_bus_direction(direction),
                            index,
                            latency,
                        )
                    },
                )?;
            }
        }
        Ok(())
    }

    pub(crate) fn deactivate(&mut self) -> HostResult<()> {
        if !self.active {
            return Ok(());
        }
        check_optional("setProcessing(false)", unsafe {
            // SAFETY: the component is processing and this runs while the
            // processor lease is paused on the owning control thread.
            ((*processor_table(&self.processor)).set_processing)(self.processor.as_ptr(), 0)
        })?;
        check("setActive(false)", unsafe {
            // SAFETY: processing has stopped and the initialized component is live.
            ((*component_table(&self.component)).set_active)(self.component.as_ptr(), 0)
        })?;
        self.active = false;
        Ok(())
    }

    #[must_use]
    pub fn kind(&self) -> PluginKind {
        self.kind
    }

    /// Returns the component's negotiated VST3 audio bus metadata.
    pub fn audio_buses(&self) -> HostResult<Vec<AudioBusDescriptor>> {
        let input_count = audio_bus_count(&self.component, Vst::BusDirections_kInput).max(0);
        let output_count = audio_bus_count(&self.component, Vst::BusDirections_kOutput).max(0);
        let mut buses = Vec::with_capacity((input_count + output_count) as usize);
        buses.extend(audio_bus_descriptors(
            &self.component,
            Vst::BusDirections_kInput,
            AudioBusDirection::Input,
        )?);
        buses.extend(audio_bus_descriptors(
            &self.component,
            Vst::BusDirections_kOutput,
            AudioBusDirection::Output,
        )?);
        Ok(buses)
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
        self.process_stereo_with_aux_context(
            input_left,
            input_right,
            output_left,
            output_right,
            &[],
            context,
        )
    }

    pub(crate) fn process_stereo_with_aux_context(
        &mut self,
        input_left: &mut [f32],
        input_right: &mut [f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
        auxiliary_inputs: &[AuxiliaryAudioInput],
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
        if self.kind == PluginKind::Effect {
            self.audio_input_buses
                .connect_main(&mut input_channels[..self.layout.input_channels() as usize]);
        }
        for input in auxiliary_inputs {
            self.audio_input_buses.connect_aux(input, frames)?;
        }
        self.audio_output_buses
            .connect_main(&mut output_channels[..self.layout.output_channels() as usize]);
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
            numInputs: self.audio_input_buses.descriptors.len() as i32,
            numOutputs: self.audio_output_buses.descriptors.len() as i32,
            inputs: if self.audio_input_buses.descriptors.is_empty() {
                std::ptr::null_mut()
            } else {
                self.audio_input_buses.descriptors.as_mut_ptr()
            },
            outputs: self.audio_output_buses.descriptors.as_mut_ptr(),
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
        if self.kind == PluginKind::Effect {
            self.audio_input_buses.disconnect_main();
        }
        for input in auxiliary_inputs {
            self.audio_input_buses.disconnect_bus(input.bus_index);
        }
        self.audio_output_buses.disconnect_main();
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
        if self.input_parameters.is_empty() {
            return Ok(());
        }
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
                    noteId: vst3_note_id(note_id),
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
                    noteId: vst3_note_id(note_id),
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
                    type_: midi_sysex_data_type(),
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
    combine_uint32_flags(&[
        Vst::IProcessContextRequirements_Flags_kNeedContinousTimeSamples,
        Vst::IProcessContextRequirements_Flags_kNeedProjectTimeMusic,
        Vst::IProcessContextRequirements_Flags_kNeedBarPositionMusic,
        Vst::IProcessContextRequirements_Flags_kNeedTempo,
        Vst::IProcessContextRequirements_Flags_kNeedTimeSignature,
        Vst::IProcessContextRequirements_Flags_kNeedTransportState,
    ])
}

fn requirement_enabled(requirements: u32, flag: impl BindgenEnum) -> bool {
    requirements & as_uint32(flag) != 0
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

#[cfg(test)]
mod tests;
