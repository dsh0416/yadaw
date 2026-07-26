use std::rc::Rc;

use yadaw_vst3_host_sys::{
    Steinberg::{
        IPluginBase,
        Vst::{
            self, AudioBusBuffers, AudioBusBuffers__bindgen_ty_1, Event, Event__bindgen_ty_1,
            IAudioProcessor, IComponent, NoteOffEvent, NoteOnEvent, ProcessData, ProcessSetup,
        },
    },
    abi::{AudioProcessorVTable, ComponentVTable},
};

use crate::{
    ClassId, ComPtr, HostError, HostResult, Module, event_list::EventList,
    host_context::HostContext,
};

const MAX_BLOCK_FRAMES: i32 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginKind {
    Effect,
    Instrument,
}

/// A stereo sample32 VST3 component with explicit lifecycle ownership.
pub struct StereoProcessor {
    processor: ComPtr<IAudioProcessor>,
    component: ComPtr<IComponent>,
    host: Box<HostContext>,
    input_events: Box<EventList>,
    module: Rc<Module>,
    kind: PluginKind,
    active: bool,
}

impl StereoProcessor {
    pub fn create(
        module: Rc<Module>,
        class_id: ClassId,
        sample_rate: f64,
        kind: PluginKind,
    ) -> HostResult<Self> {
        let component = module.create::<IComponent>(class_id)?;
        let host = HostContext::new();
        let input_events = EventList::new();
        let component_table = component_table(&component);
        check("IComponent::initialize", unsafe {
            // SAFETY: component and host are live and owned by this
            // construction path.
            ((*component_table).base.initialize)(
                component.as_ptr().cast::<IPluginBase>(),
                host.as_unknown(),
            )
        })?;
        let processor = component.query::<IAudioProcessor>()?;
        let processor_table = processor_table(&processor);
        check("canProcessSampleSize(sample32)", unsafe {
            // SAFETY: processor is initialized and live.
            ((*processor_table).can_process_sample_size)(
                processor.as_ptr(),
                Vst::SymbolicSampleSizes_kSample32,
            )
        })?;

        let mut input_arrangement = Vst::SpeakerArr::kStereo;
        let mut output_arrangement = Vst::SpeakerArr::kStereo;
        let input_count = i32::from(kind == PluginKind::Effect);
        check("setBusArrangements", unsafe {
            // SAFETY: arrangement pointers remain valid for the call.
            ((*processor_table).set_bus_arrangements)(
                processor.as_ptr(),
                std::ptr::addr_of_mut!(input_arrangement),
                input_count,
                std::ptr::addr_of_mut!(output_arrangement),
                1,
            )
        })?;

        if kind == PluginKind::Effect {
            check("activate audio input", unsafe {
                // SAFETY: component is initialized; bus zero is the
                // negotiated stereo main input.
                ((*component_table).activate_bus)(
                    component.as_ptr(),
                    Vst::MediaTypes_kAudio,
                    Vst::BusDirections_kInput,
                    0,
                    1,
                )
            })?;
        }
        check("activate audio output", unsafe {
            // SAFETY: component is initialized; bus zero is the
            // negotiated stereo main output.
            ((*component_table).activate_bus)(
                component.as_ptr(),
                Vst::MediaTypes_kAudio,
                Vst::BusDirections_kOutput,
                0,
                1,
            )
        })?;
        let mut setup = ProcessSetup {
            processMode: Vst::ProcessModes_kRealtime,
            symbolicSampleSize: Vst::SymbolicSampleSizes_kSample32,
            maxSamplesPerBlock: MAX_BLOCK_FRAMES,
            sampleRate: sample_rate,
        };
        check("setupProcessing", unsafe {
            // SAFETY: setup is initialized and valid for this call.
            ((*processor_table).setup_processing)(processor.as_ptr(), std::ptr::addr_of_mut!(setup))
        })?;
        check("setActive(true)", unsafe {
            // SAFETY: all buses and processing configuration are set.
            ((*component_table).set_active)(component.as_ptr(), 1)
        })?;
        check_optional("setProcessing(true)", unsafe {
            // SAFETY: component is active.
            ((*processor_table).set_processing)(processor.as_ptr(), 1)
        })?;
        Ok(Self {
            processor,
            component,
            host,
            input_events,
            module,
            kind,
            active: true,
        })
    }

    #[must_use]
    pub fn kind(&self) -> PluginKind {
        self.kind
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
            numChannels: 2,
            silenceFlags: 0,
            __bindgen_anon_1: AudioBusBuffers__bindgen_ty_1 {
                channelBuffers32: input_channels.as_mut_ptr(),
            },
        };
        let mut output_bus = AudioBusBuffers {
            numChannels: 2,
            silenceFlags: 0,
            __bindgen_anon_1: AudioBusBuffers__bindgen_ty_1 {
                channelBuffers32: output_channels.as_mut_ptr(),
            },
        };
        let event_list = (!self.input_events.is_empty()).then(|| self.input_events.as_interface());
        let mut data = ProcessData {
            processMode: Vst::ProcessModes_kRealtime,
            symbolicSampleSize: Vst::SymbolicSampleSizes_kSample32,
            numSamples: frames as i32,
            numInputs: i32::from(self.kind == PluginKind::Effect),
            numOutputs: 1,
            inputs: if self.kind == PluginKind::Effect {
                std::ptr::addr_of_mut!(input_bus)
            } else {
                std::ptr::null_mut()
            },
            outputs: std::ptr::addr_of_mut!(output_bus),
            inputParameterChanges: std::ptr::null_mut(),
            outputParameterChanges: std::ptr::null_mut(),
            inputEvents: event_list.unwrap_or(std::ptr::null_mut()),
            outputEvents: std::ptr::null_mut(),
            processContext: std::ptr::null_mut(),
        };
        let result = check("process", unsafe {
            // SAFETY: all channel arrays and ProcessData storage remain
            // valid and uniquely borrowed for the duration of the call.
            ((*processor_table(&self.processor)).process)(
                self.processor.as_ptr(),
                std::ptr::addr_of_mut!(data),
            )
        });
        self.input_events.clear();
        result
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
}

impl Drop for StereoProcessor {
    fn drop(&mut self) {
        if self.active {
            let processor_table = processor_table(&self.processor);
            let component_table = component_table(&self.component);
            unsafe {
                // SAFETY: lifecycle teardown is performed once in reverse
                // activation order while all interfaces and the module live.
                ((*processor_table).set_processing)(self.processor.as_ptr(), 0);
                ((*component_table).set_active)(self.component.as_ptr(), 0);
                ((*component_table).base.terminate)(self.component.as_ptr().cast::<IPluginBase>());
            }
            self.active = false;
        }
        let _keep_alive = (&self.module, &self.host);
    }
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
    if result == 0 || result == -2147467263 {
        Ok(())
    } else {
        Err(HostError::Operation { operation, result })
    }
}
