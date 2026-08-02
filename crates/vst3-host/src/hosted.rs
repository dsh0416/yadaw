use std::{
    cell::{Cell, UnsafeCell},
    ffi::c_void,
    marker::PhantomData,
    ptr::NonNull,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
};

use yadaw_vst3_host_sys::{
    Steinberg::{
        IPlugFrame, IPlugView, IPlugViewContentScaleSupport, IPluginBase, TUID, ViewRect,
        Vst::{self, IComponent, IConnectionPoint, IEditController, IMidiMapping, ParameterInfo},
    },
    abi::{
        ComponentVTable, ConnectionPointVTable, EditControllerVTable, MidiMappingVTable,
        PlugViewContentScaleSupportVTable, PlugViewVTable,
    },
    compat::tuid_byte,
};

use crate::{
    AudioLayout, ClassId, ComPtr, HostError, HostResult, Module, PluginKind, StereoProcessor,
    component_handler::{ComponentHandler, HandlerShared},
    output_parameter_bridge::{OutputParameterReader, output_parameter_bridge},
    processor::HostProcessContext,
    stream::MemoryStream,
};

#[cfg(target_os = "windows")]
unsafe extern "C" {
    fn yadaw_vst3_guarded_attach(
        view: *mut IPlugView,
        parent: *mut c_void,
        platform: *const std::ffi::c_char,
    ) -> i32;
}

#[derive(Clone, Debug, PartialEq)]
pub struct HostedParameter {
    pub id: u32,
    pub title: String,
    pub short_title: String,
    pub units: String,
    pub step_count: i32,
    pub default_normalized: f64,
    pub normalized: f64,
    pub formatted: String,
    pub flags: u32,
}

const MIDI_MAPPING_CHANNELS: usize = 16;
const MIDI_MAPPING_CONTROLLERS: usize = 131;
const MIDI_AFTERTOUCH: usize = 128;
const MIDI_PITCH_BEND: usize = 129;
const MIDI_PROGRAM_CHANGE: usize = 130;
const UNMAPPED_PARAMETER: u32 = u32::MAX;

struct MidiMappingTable {
    parameters: Box<[AtomicU32]>,
}

impl MidiMappingTable {
    fn query(controller: Option<&ComPtr<IEditController>>) -> Self {
        let parameters = (0..MIDI_MAPPING_CHANNELS * MIDI_MAPPING_CONTROLLERS)
            .map(|_| AtomicU32::new(UNMAPPED_PARAMETER))
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let Some(mapping) = controller.and_then(|value| value.query::<IMidiMapping>().ok()) else {
            return Self { parameters };
        };
        let table = Self { parameters };
        table.refresh_mapping(&mapping);
        table
    }

    fn refresh(&self, controller: Option<&ComPtr<IEditController>>) {
        let Some(mapping) = controller.and_then(|value| value.query::<IMidiMapping>().ok()) else {
            for parameter in &self.parameters {
                parameter.store(UNMAPPED_PARAMETER, Ordering::Release);
            }
            return;
        };
        self.refresh_mapping(&mapping);
    }

    fn refresh_mapping(&self, mapping: &ComPtr<IMidiMapping>) {
        let table = midi_mapping_table(mapping);
        for channel in 0..MIDI_MAPPING_CHANNELS {
            for controller in 0..MIDI_MAPPING_CONTROLLERS {
                let mut parameter = UNMAPPED_PARAMETER;
                let result = unsafe {
                    // SAFETY: the controller is live, the bus/channel/controller values are in
                    // the VST3 MIDI mapping range, and parameter is writable.
                    ((*table).get_midi_controller_assignment)(
                        mapping.as_ptr(),
                        0,
                        channel as i16,
                        controller as i16,
                        std::ptr::addr_of_mut!(parameter),
                    )
                };
                self.parameters[channel * MIDI_MAPPING_CONTROLLERS + controller].store(
                    if result == 0 {
                        parameter
                    } else {
                        UNMAPPED_PARAMETER
                    },
                    Ordering::Release,
                );
            }
        }
    }

    fn parameter(&self, channel: u8, controller: usize) -> Option<u32> {
        let index = usize::from(channel)
            .checked_mul(MIDI_MAPPING_CONTROLLERS)?
            .checked_add(controller)?;
        self.parameters
            .get(index)
            .map(|value| value.load(Ordering::Acquire))
            .filter(|value| *value != UNMAPPED_PARAMETER)
    }
}

struct ProcessorCell {
    processor: UnsafeCell<StereoProcessor>,
    paused: AtomicBool,
    processing: AtomicBool,
}

impl ProcessorCell {
    fn new(processor: StereoProcessor) -> Box<Self> {
        Box::new(Self {
            processor: UnsafeCell::new(processor),
            paused: AtomicBool::new(false),
            processing: AtomicBool::new(false),
        })
    }

    fn with_paused<T>(&self, action: impl FnOnce(&mut StereoProcessor) -> T) -> T {
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
    cell: NonNull<ProcessorCell>,
    midi_mapping: Arc<MidiMappingTable>,
    _lifetime: Arc<()>,
    _not_sync: PhantomData<Cell<()>>,
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
            (&mut *cell.processor.get()).process_stereo_with_context(
                input_left,
                input_right,
                output_left,
                output_right,
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

pub struct HostedPlugin {
    processor: Box<ProcessorCell>,
    processor_lifetime: Arc<()>,
    midi_mapping: Arc<MidiMappingTable>,
    controller: Option<ComPtr<IEditController>>,
    connections: Option<ComponentConnections>,
    handler: Option<Box<ComponentHandler>>,
    shared: Arc<HandlerShared>,
    output_parameter_reader: OutputParameterReader,
    controller_initialized: bool,
    class_id: ClassId,
}

struct ComponentConnections {
    component: ComPtr<IConnectionPoint>,
    controller: ComPtr<IConnectionPoint>,
    component_connected: bool,
    controller_connected: bool,
}

impl ComponentConnections {
    fn connect(
        component: ComPtr<IConnectionPoint>,
        controller: ComPtr<IConnectionPoint>,
    ) -> HostResult<Self> {
        let mut connections = Self {
            component,
            controller,
            component_connected: false,
            controller_connected: false,
        };
        check("IConnectionPoint::connect(component)", unsafe {
            // SAFETY: both retained connection points are initialized and live.
            ((*connection_table(&connections.component)).connect)(
                connections.component.as_ptr(),
                connections.controller.as_ptr(),
            )
        })?;
        connections.component_connected = true;
        check("IConnectionPoint::connect(controller)", unsafe {
            // SAFETY: both retained connection points are initialized and live.
            ((*connection_table(&connections.controller)).connect)(
                connections.controller.as_ptr(),
                connections.component.as_ptr(),
            )
        })?;
        connections.controller_connected = true;
        Ok(connections)
    }
}

impl Drop for ComponentConnections {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: each successful connect is balanced once while both retained peers live.
            if self.controller_connected {
                ((*connection_table(&self.controller)).disconnect)(
                    self.controller.as_ptr(),
                    self.component.as_ptr(),
                );
            }
            if self.component_connected {
                ((*connection_table(&self.component)).disconnect)(
                    self.component.as_ptr(),
                    self.controller.as_ptr(),
                );
            }
        }
    }
}

impl HostedPlugin {
    pub fn create(
        module_path: impl AsRef<std::path::Path>,
        class_id: ClassId,
        sample_rate: f64,
        kind: PluginKind,
    ) -> HostResult<Self> {
        Self::create_with_layout(
            module_path,
            class_id,
            sample_rate,
            kind,
            AudioLayout::Stereo,
        )
    }

    pub fn create_with_layout(
        module_path: impl AsRef<std::path::Path>,
        class_id: ClassId,
        sample_rate: f64,
        kind: PluginKind,
        layout: AudioLayout,
    ) -> HostResult<Self> {
        Self::create_with_layout_and_hook(
            module_path,
            class_id,
            sample_rate,
            kind,
            layout,
            |_, _| Ok(()),
        )
        .map(|(plugin, ())| plugin)
    }

    pub fn create_with_layout_and_hook<T>(
        module_path: impl AsRef<std::path::Path>,
        class_id: ClassId,
        sample_rate: f64,
        kind: PluginKind,
        layout: AudioLayout,
        hook: impl FnOnce(&Module, *mut c_void) -> HostResult<T>,
    ) -> HostResult<(Self, T)> {
        let module = Rc::new(Module::open(module_path)?);
        let hook_module = Rc::clone(&module);
        let (mut processor, parameter_producer, hook_result) =
            StereoProcessor::create_with_parameter_queue_and_hook(
                module.clone(),
                class_id,
                sample_rate,
                kind,
                layout,
                move |component| hook(&hook_module, component),
            )?;
        let shared = HandlerShared::new(parameter_producer);
        let (controller, separate_controller) = create_controller(&module, &processor)?;
        let parameter_ids = controller
            .as_ref()
            .map(controller_parameter_ids)
            .transpose()?
            .unwrap_or_default();
        let (output_parameter_writer, output_parameter_reader) =
            output_parameter_bridge(parameter_ids);
        processor.set_output_parameter_writer(output_parameter_writer);
        let midi_mapping = Arc::new(MidiMappingTable::query(controller.as_ref()));
        let mut handler = controller
            .as_ref()
            .map(|_| ComponentHandler::new(shared.clone()));
        if let (Some(controller), Some(handler)) = (&controller, handler.as_mut()) {
            check("IEditController::setComponentHandler", unsafe {
                // SAFETY: controller is initialized and handler has a stable Box address that
                // remains owned until setComponentHandler(null) during Drop.
                ((*controller_table(controller)).set_component_handler)(
                    controller.as_ptr(),
                    handler.as_interface(),
                )
            })?;
        }
        let connections = if separate_controller {
            match (
                processor.component().query::<IConnectionPoint>(),
                controller
                    .as_ref()
                    .ok_or(HostError::NullInterface("IEditController"))?
                    .query::<IConnectionPoint>(),
            ) {
                (Ok(component), Ok(controller)) => {
                    Some(ComponentConnections::connect(component, controller)?)
                }
                (Err(error), _) | (_, Err(error)) => return Err(error),
            }
        } else {
            None
        };
        processor.activate()?;
        Ok((
            Self {
                processor: ProcessorCell::new(processor),
                processor_lifetime: Arc::new(()),
                midi_mapping,
                controller,
                connections,
                handler,
                shared,
                output_parameter_reader,
                controller_initialized: true,
                class_id,
            },
            hook_result,
        ))
    }

    pub fn mirror_parameters_to(&self, target: &Self) {
        self.shared.set_parameter_mirror(target.shared.clone());
    }

    /// Runs one controller-thread operation while no audio lease can enter `process`.
    pub fn with_processing_paused<T>(&self, action: impl FnOnce() -> T) -> T {
        self.processor.with_paused(|_| action())
    }

    #[must_use]
    pub fn class_id(&self) -> ClassId {
        self.class_id
    }

    #[must_use]
    pub fn processor_lease(&self) -> ProcessorLease {
        ProcessorLease {
            cell: NonNull::from(self.processor.as_ref()),
            midi_mapping: Arc::clone(&self.midi_mapping),
            _lifetime: Arc::clone(&self.processor_lifetime),
            _not_sync: PhantomData,
        }
    }

    /// Returns true while an audio graph can still dereference this plug-in's processor cell.
    ///
    /// The owner must first prevent new leases from being created. Once the count reaches one,
    /// no external lease remains that could clone itself, so dropping the stable cell is safe.
    #[must_use]
    pub fn has_outstanding_processor_leases(&self) -> bool {
        Arc::strong_count(&self.processor_lifetime) > 1
    }

    #[must_use]
    pub fn latency_samples(&self) -> u32 {
        self.processor
            .with_paused(|processor| processor.latency_samples())
    }

    #[must_use]
    pub fn tail_samples(&self) -> Option<u32> {
        self.processor
            .with_paused(|processor| processor.tail_samples())
    }

    #[must_use]
    pub fn take_restart_requests(&self) -> crate::Vst3RestartRequest {
        self.shared.take_restart_requests()
    }

    pub fn apply_restart_requests(&mut self, request: crate::Vst3RestartRequest) -> HostResult<()> {
        if request.contains(crate::Vst3RestartRequest::RELOAD_COMPONENT) {
            return Err(HostError::Operation {
                operation: "restartComponent(kReloadComponent) requires instance reload",
                result: -2147467259,
            });
        }
        if request.contains(crate::Vst3RestartRequest::MIDI_CC_ASSIGNMENT_CHANGED) {
            self.midi_mapping.refresh(self.controller.as_ref());
        }
        if request.contains(crate::Vst3RestartRequest::PARAM_ID_MAPPING_CHANGED) {
            let parameter_ids = self
                .controller
                .as_ref()
                .map(controller_parameter_ids)
                .transpose()?
                .unwrap_or_default();
            let (writer, reader) = output_parameter_bridge(parameter_ids);
            self.processor
                .with_paused(|processor| processor.set_output_parameter_writer(writer));
            self.output_parameter_reader = reader;
        }
        if request.contains(crate::Vst3RestartRequest::IO_CHANGED)
            || request.contains(crate::Vst3RestartRequest::LATENCY_CHANGED)
        {
            self.processor
                .with_paused(StereoProcessor::restart_processing)?;
        }
        Ok(())
    }

    pub fn flush_output_parameters(&mut self) -> HostResult<usize> {
        let Some(controller) = &self.controller else {
            return Ok(0);
        };
        let table = controller_table(controller);
        let mut first_error = None;
        let applied = self.output_parameter_reader.drain(|id, value| {
            let result = unsafe {
                // SAFETY: the controller is live and this method only runs on its owning UI
                // thread. Output parameters update the controller without feeding the value back
                // into the processor's input queue.
                ((*table).set_parameter_normalized)(controller.as_ptr(), id, value)
            };
            if result != 0 && first_error.is_none() {
                first_error = Some(HostError::Operation {
                    operation: "IEditController::setParamNormalized(output)",
                    result,
                });
            }
        });
        first_error.map_or(Ok(applied), Err)
    }

    pub fn parameters(&self) -> HostResult<Vec<HostedParameter>> {
        let Some(controller) = &self.controller else {
            return Ok(Vec::new());
        };
        let table = controller_table(controller);
        let count = unsafe {
            // SAFETY: controller is live on its owning UI thread.
            ((*table).parameter_count)(controller.as_ptr())
        }
        .max(0);
        let mut parameters = Vec::with_capacity(count as usize);
        for index in 0..count {
            let mut raw = std::mem::MaybeUninit::<ParameterInfo>::zeroed();
            check("IEditController::getParameterInfo", unsafe {
                // SAFETY: index is below parameter_count and raw is writable SDK storage.
                ((*table).parameter_info)(controller.as_ptr(), index, raw.as_mut_ptr())
            })?;
            let raw = unsafe {
                // SAFETY: a successful parameter_info call initialized the POD.
                raw.assume_init()
            };
            let normalized = unsafe {
                // SAFETY: controller is live and raw.id came from this controller.
                ((*table).parameter_normalized)(controller.as_ptr(), raw.id)
            };
            let mut text = [0_u16; 128];
            let string_result = unsafe {
                // SAFETY: controller is live, raw.id belongs to it, and text is writable String128 storage.
                ((*table).parameter_string)(
                    controller.as_ptr(),
                    raw.id,
                    normalized,
                    text.as_mut_ptr(),
                )
            };
            let flags = raw.flags as u32;
            if flags & Vst::ParameterInfo_ParameterFlags_kIsHidden as u32 != 0 {
                continue;
            }
            parameters.push(HostedParameter {
                id: raw.id,
                title: utf16_string(&raw.title),
                short_title: utf16_string(&raw.shortTitle),
                units: utf16_string(&raw.units),
                step_count: raw.stepCount,
                default_normalized: raw.defaultNormalizedValue,
                normalized,
                formatted: if string_result == 0 {
                    utf16_string(&text)
                } else {
                    String::new()
                },
                flags,
            });
        }
        Ok(parameters)
    }

    pub fn set_parameter(&self, id: u32, normalized: f64, flush: bool) -> HostResult<()> {
        if !normalized.is_finite() || !(0.0..=1.0).contains(&normalized) {
            return Err(HostError::Operation {
                operation: "parameter value outside 0...1",
                result: -2147024809,
            });
        }
        if let Some(controller) = &self.controller
            && let Some(flags) = controller_parameter_flags(controller, id)?
            && flags
                & (Vst::ParameterInfo_ParameterFlags_kIsReadOnly as u32
                    | Vst::ParameterInfo_ParameterFlags_kIsHidden as u32)
                != 0
        {
            return Err(HostError::Operation {
                operation: "parameter is read-only or hidden",
                result: -2147024891,
            });
        }
        if !self.shared.enqueue_parameter(id, normalized) {
            return Err(HostError::Operation {
                operation: "realtime parameter queue full",
                result: 1,
            });
        }
        if let Some(controller) = &self.controller {
            check("IEditController::setParamNormalized", unsafe {
                // SAFETY: controller is live on its UI thread and the value is normalized.
                ((*controller_table(controller)).set_parameter_normalized)(
                    controller.as_ptr(),
                    id,
                    normalized,
                )
            })?;
        }
        if flush {
            self.processor
                .with_paused(StereoProcessor::flush_parameters)?;
        }
        Ok(())
    }

    pub fn restore_state(&self, component_state: &[u8], controller_state: &[u8]) -> HostResult<()> {
        self.processor.with_paused(|processor| {
            let mut component_stream = MemoryStream::from_slice(component_state);
            check("IComponent::setState", unsafe {
                // SAFETY: component is live, processing is paused, and stream remains valid.
                ((*component_table(processor.component())).set_state)(
                    processor.component().as_ptr(),
                    component_stream.as_interface(),
                )
            })?;
            if let Some(controller) = &self.controller {
                component_stream.rewind();
                check("IEditController::setComponentState", unsafe {
                    // SAFETY: controller and stream are live on the UI thread.
                    ((*controller_table(controller)).set_component_state)(
                        controller.as_ptr(),
                        component_stream.as_interface(),
                    )
                })?;
                if !controller_state.is_empty() {
                    let mut stream = MemoryStream::from_slice(controller_state);
                    check("IEditController::setState", unsafe {
                        // SAFETY: controller and stream are live on the UI thread.
                        ((*controller_table(controller)).set_state)(
                            controller.as_ptr(),
                            stream.as_interface(),
                        )
                    })?;
                }
            }
            Ok(())
        })
    }

    pub fn save_state(&self) -> HostResult<(Vec<u8>, Vec<u8>)> {
        let component_state = self.processor.with_paused(|processor| {
            let mut stream = MemoryStream::empty();
            check("IComponent::getState", unsafe {
                // SAFETY: component is live, processing is paused, and stream is writable.
                ((*component_table(processor.component())).get_state)(
                    processor.component().as_ptr(),
                    stream.as_interface(),
                )
            })?;
            Ok(stream.into_bytes())
        })?;
        let controller_state = if let Some(controller) = &self.controller {
            let mut stream = MemoryStream::empty();
            check("IEditController::getState", unsafe {
                // SAFETY: controller is live on the owning UI thread and stream is writable.
                ((*controller_table(controller)).get_state)(
                    controller.as_ptr(),
                    stream.as_interface(),
                )
            })?;
            stream.into_bytes()
        } else {
            Vec::new()
        };
        Ok((component_state, controller_state))
    }

    pub fn create_view(&self) -> HostResult<PlugView> {
        let controller = self
            .controller
            .as_ref()
            .ok_or(HostError::NullInterface("IEditController"))?;
        let view = unsafe {
            // SAFETY: controller is live and "editor" is the SDK-defined NUL-terminated view name.
            ((*controller_table(controller)).create_view)(controller.as_ptr(), c"editor".as_ptr())
        };
        let view = unsafe {
            // SAFETY: a non-null createView result transfers one owned IPlugView reference.
            ComPtr::from_raw(view, "IEditController::createView")?
        };
        Ok(PlugView { view })
    }
}

impl Drop for HostedPlugin {
    fn drop(&mut self) {
        self.connections.take();
        if let Some(controller) = &self.controller {
            unsafe {
                // SAFETY: controller is live; clearing the handler precedes handler release.
                ((*controller_table(controller)).set_component_handler)(
                    controller.as_ptr(),
                    std::ptr::null_mut(),
                );
            }
        }
        self.handler.take();
        if self.controller_initialized {
            if let Some(controller) = &self.controller {
                unsafe {
                    // SAFETY: controller termination occurs once after views and handler are gone.
                    ((*controller_table(controller)).base.terminate)(
                        controller.as_ptr().cast::<IPluginBase>(),
                    );
                }
            }
            self.controller_initialized = false;
        }
    }
}

pub struct PlugView {
    view: ComPtr<IPlugView>,
}

impl PlugView {
    #[must_use]
    pub fn as_ptr(&self) -> *mut IPlugView {
        self.view.as_ptr()
    }

    pub fn supports_platform(&self, platform: &'static std::ffi::CStr) -> bool {
        unsafe {
            // SAFETY: view and static platform string are live.
            ((*view_table(&self.view)).is_platform_type_supported)(
                self.view.as_ptr(),
                platform.as_ptr(),
            ) == 0
        }
    }

    pub fn size(&self) -> HostResult<ViewRect> {
        let mut size = ViewRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        check("IPlugView::getSize", unsafe {
            // SAFETY: view is live and size is writable.
            ((*view_table(&self.view)).size)(self.view.as_ptr(), &mut size)
        })?;
        Ok(size)
    }

    pub fn can_resize(&self) -> bool {
        unsafe {
            // SAFETY: view is live.
            ((*view_table(&self.view)).can_resize)(self.view.as_ptr()) == 0
        }
    }

    pub fn constrain_size(&self, size: &mut ViewRect) -> HostResult<()> {
        check("IPlugView::checkSizeConstraint", unsafe {
            // SAFETY: view is live and size is writable.
            ((*view_table(&self.view)).check_size_constraint)(self.view.as_ptr(), size)
        })
    }

    /// # Safety
    ///
    /// `frame` must be null or point to a live `IPlugFrame` that remains valid
    /// until this view is cleared with another `set_frame` call.
    pub unsafe fn set_frame(&self, frame: *mut IPlugFrame) -> HostResult<()> {
        check("IPlugView::setFrame", unsafe {
            // SAFETY: view is live and frame is either null or retained by the editor window.
            ((*view_table(&self.view)).set_frame)(self.view.as_ptr(), frame)
        })
    }

    /// # Safety
    ///
    /// `parent` must be a live native container of `platform` and must remain
    /// valid until [`Self::removed`] is called.
    pub unsafe fn attach(
        &self,
        parent: *mut c_void,
        platform: &'static std::ffi::CStr,
    ) -> HostResult<()> {
        #[cfg(target_os = "windows")]
        let result = unsafe {
            // SAFETY: the platform-specific child container stays alive until removed. The
            // narrow native guard converts a third-party structured exception into a failed
            // attach result so the host can fall back to its parameter editor.
            yadaw_vst3_guarded_attach(self.view.as_ptr(), parent, platform.as_ptr())
        };
        #[cfg(not(target_os = "windows"))]
        let result = unsafe {
            // SAFETY: the platform-specific child container stays alive until removed.
            let table = view_table(&self.view);
            ((*table).attached)(self.view.as_ptr(), parent, platform.as_ptr())
        };
        check("IPlugView::attached", result)
    }

    pub fn removed(&self) {
        unsafe {
            // SAFETY: view is attached at most once and removal is idempotently tracked by caller.
            ((*view_table(&self.view)).removed)(self.view.as_ptr());
        }
    }

    pub fn on_size(&self, size: &mut ViewRect) -> HostResult<()> {
        check("IPlugView::onSize", unsafe {
            // SAFETY: view is live and size uses the platform coordinate unit.
            ((*view_table(&self.view)).on_size)(self.view.as_ptr(), size)
        })
    }

    /// Notifies a view from an `IPlugFrame::resizeView` callback without
    /// borrowing the host-owned [`PlugView`]. This is required because VST3
    /// permits `resizeView` to be called synchronously from `attached`.
    ///
    /// # Safety
    ///
    /// `view` must be the live view passed to the matching frame callback and
    /// `size` must use that platform's VST3 coordinate unit.
    pub unsafe fn on_size_raw(view: *mut IPlugView, size: &mut ViewRect) -> HostResult<()> {
        if view.is_null() {
            return Err(HostError::NullInterface("IPlugView"));
        }
        let table = unsafe {
            // SAFETY: the caller guarantees a live IPlugView interface.
            *view.cast::<*const PlugViewVTable>()
        };
        check("IPlugView::onSize", unsafe {
            // SAFETY: view and writable size satisfy this method's contract.
            ((*table).on_size)(view, size)
        })
    }

    pub fn set_content_scale_factor(&self, factor: f32) -> HostResult<bool> {
        let Ok(scale) = self.view.query::<IPlugViewContentScaleSupport>() else {
            return Ok(false);
        };
        let table = unsafe {
            // SAFETY: ComPtr guarantees the leading content-scale vtable pointer.
            *scale
                .as_ptr()
                .cast::<*const PlugViewContentScaleSupportVTable>()
        };
        Ok(unsafe {
            // SAFETY: scale interface is live and factor is supplied by validated host settings.
            ((*table).set_content_scale_factor)(scale.as_ptr(), factor) == 0
        })
    }
}

fn create_controller(
    module: &Rc<Module>,
    processor: &StereoProcessor,
) -> HostResult<(Option<ComPtr<IEditController>>, bool)> {
    let mut controller_id: TUID = [tuid_byte(0); 16];
    let result = unsafe {
        // SAFETY: component is initialized and controller_id is writable TUID storage.
        ((*component_table(processor.component())).get_controller_class_id)(
            processor.component().as_ptr(),
            controller_id.as_mut_ptr(),
        )
    };
    if result != 0 {
        return Ok((processor.component().query::<IEditController>().ok(), false));
    }
    let controller = module.create::<IEditController>(ClassId::from_tuid(controller_id))?;
    check("IEditController::initialize", unsafe {
        // SAFETY: controller is newly created and shares the live host context.
        ((*controller_table(&controller)).base.initialize)(
            controller.as_ptr().cast::<IPluginBase>(),
            processor.host().as_unknown(),
        )
    })?;
    Ok((Some(controller), true))
}

fn controller_parameter_ids(controller: &ComPtr<IEditController>) -> HostResult<Vec<u32>> {
    let table = controller_table(controller);
    let count = unsafe {
        // SAFETY: controller is initialized and live on its owning UI thread.
        ((*table).parameter_count)(controller.as_ptr())
    }
    .max(0);
    let mut ids = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut raw = std::mem::MaybeUninit::<ParameterInfo>::zeroed();
        check("IEditController::getParameterInfo(output bridge)", unsafe {
            // SAFETY: index is below parameter_count and raw is writable SDK storage.
            ((*table).parameter_info)(controller.as_ptr(), index, raw.as_mut_ptr())
        })?;
        let raw = unsafe {
            // SAFETY: a successful parameter_info call initialized the POD.
            raw.assume_init()
        };
        ids.push(raw.id);
    }
    Ok(ids)
}

fn controller_parameter_flags(
    controller: &ComPtr<IEditController>,
    id: u32,
) -> HostResult<Option<u32>> {
    let table = controller_table(controller);
    let count = unsafe {
        // SAFETY: controller is initialized and live on its owning UI thread.
        ((*table).parameter_count)(controller.as_ptr())
    }
    .max(0);
    for index in 0..count {
        let mut raw = std::mem::MaybeUninit::<ParameterInfo>::zeroed();
        check("IEditController::getParameterInfo(flags)", unsafe {
            // SAFETY: index is below parameter_count and raw is writable SDK storage.
            ((*table).parameter_info)(controller.as_ptr(), index, raw.as_mut_ptr())
        })?;
        let raw = unsafe {
            // SAFETY: successful parameter_info initialized the POD.
            raw.assume_init()
        };
        if raw.id == id {
            return Ok(Some(raw.flags as u32));
        }
    }
    Ok(None)
}

fn component_table(component: &ComPtr<IComponent>) -> *const ComponentVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *component.as_ptr().cast::<*const ComponentVTable>()
    }
}

fn midi_mapping_table(mapping: &ComPtr<IMidiMapping>) -> *const MidiMappingVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *mapping.as_ptr().cast::<*const MidiMappingVTable>()
    }
}

fn controller_table(controller: &ComPtr<IEditController>) -> *const EditControllerVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *controller.as_ptr().cast::<*const EditControllerVTable>()
    }
}

fn connection_table(connection: &ComPtr<IConnectionPoint>) -> *const ConnectionPointVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *connection.as_ptr().cast::<*const ConnectionPointVTable>()
    }
}

fn view_table(view: &ComPtr<IPlugView>) -> *const PlugViewVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *view.as_ptr().cast::<*const PlugViewVTable>()
    }
}

fn utf16_string(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

fn check(operation: &'static str, result: i32) -> HostResult<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(HostError::Operation { operation, result })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_midi_mapping_and_out_of_range_queries_are_unmapped() {
        let mapping = MidiMappingTable::query(None);

        assert_eq!(mapping.parameter(0, 0), None);
        assert_eq!(mapping.parameter(15, MIDI_PROGRAM_CHANGE), None);
        assert_eq!(mapping.parameter(16, 0), None);
        assert_eq!(mapping.parameter(0, MIDI_MAPPING_CONTROLLERS), None);
    }

    #[test]
    fn midi_mapping_returns_only_assigned_parameters() {
        let mut parameters =
            vec![UNMAPPED_PARAMETER; MIDI_MAPPING_CHANNELS * MIDI_MAPPING_CONTROLLERS]
                .into_boxed_slice();
        parameters[MIDI_MAPPING_CONTROLLERS + MIDI_PITCH_BEND] = 77;
        let mapping = MidiMappingTable { parameters };

        assert_eq!(mapping.parameter(1, MIDI_PITCH_BEND), Some(77));
        assert_eq!(mapping.parameter(1, MIDI_AFTERTOUCH), None);
    }

    #[test]
    fn utf16_string_stops_at_nul_and_replaces_invalid_sequences() {
        assert_eq!(
            utf16_string(&[b'A' as u16, b'B' as u16, 0, b'C' as u16]),
            "AB"
        );
        assert_eq!(utf16_string(&[0xd800, 0]), "�");
        assert_eq!(utf16_string(&[]), "");
    }

    #[test]
    fn vst3_result_mapping_preserves_operation_and_result_code() {
        assert!(check("activate", 0).is_ok());
        assert!(matches!(
            check("activate", -7),
            Err(HostError::Operation {
                operation: "activate",
                result: -7,
            })
        ));
    }
}
