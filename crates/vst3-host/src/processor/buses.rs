use heron_vst3_host_sys::{
    Steinberg::{
        IPluginBase,
        Vst::{
            self, AudioBusBuffers, AudioBusBuffers__bindgen_ty_1, BusDirections, BusInfo,
            IAudioPresentationLatency, IAudioProcessor, IComponent, IProcessContextRequirements,
            SpeakerArrangement,
        },
    },
    abi::{
        AudioPresentationLatencyVTable, AudioProcessorVTable, ComponentVTable,
        ProcessContextRequirementsVTable,
    },
    compat::{as_bus_direction, as_int32, as_media_type, as_uint32},
};

use crate::{ComPtr, HostError, HostResult};

use super::{
    AudioBusDescriptor, AudioBusDirection, AudioBusKind, AudioBusStorage, AudioLayout,
    BusActivationOverride, MAX_BLOCK_FRAMES, PluginKind,
};

/// Owns an initialized VST3 component until construction succeeds or fails.
///
/// On failure, tears down with `setProcessing(false)` / `setActive(false)` /
/// `terminate()` before `ComPtr` release. Skipping `terminate()` after a
/// successful `initialize()` crashes some commercial instruments (Kontakt).
pub(super) struct InitializedComponent {
    component: Option<ComPtr<IComponent>>,
    processor: Option<ComPtr<IAudioProcessor>>,
    active: bool,
    processing: bool,
}

impl InitializedComponent {
    pub(super) fn new(component: ComPtr<IComponent>) -> Self {
        Self {
            component: Some(component),
            processor: None,
            active: false,
            processing: false,
        }
    }

    pub(super) fn component(&self) -> &ComPtr<IComponent> {
        self.component
            .as_ref()
            .expect("initialized component is present until take()")
    }

    pub(super) fn set_processor(&mut self, processor: ComPtr<IAudioProcessor>) {
        self.processor = Some(processor);
    }

    pub(super) fn take(mut self) -> (ComPtr<IComponent>, ComPtr<IAudioProcessor>) {
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

pub(super) fn audio_bus_count(component: &ComPtr<IComponent>, direction: BusDirections) -> i32 {
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

pub(super) fn audio_bus_is_active(
    kind: PluginKind,
    direction: BusDirections,
    index: i32,
    overrides: &[BusActivationOverride],
) -> bool {
    overrides
        .iter()
        .rev()
        .find(|entry| {
            entry.media_type == as_media_type(Vst::MediaTypes_kAudio)
                && entry.direction == as_bus_direction(direction)
                && entry.index == index
        })
        .map_or_else(
            || {
                index == 0
                    && (direction == Vst::BusDirections_kOutput || kind == PluginKind::Effect)
            },
            |entry| entry.active,
        )
}

pub(super) fn silence_flags(channels: usize) -> u64 {
    match channels {
        0 => 0,
        64.. => u64::MAX,
        _ => (1_u64 << channels) - 1,
    }
}

pub(super) fn prepare_audio_bus_storage(
    component: &ComPtr<IComponent>,
    direction: BusDirections,
) -> HostResult<AudioBusStorage> {
    let count = audio_bus_count(component, direction) as usize;
    let input = direction == Vst::BusDirections_kInput;
    let mut channel_counts = Vec::with_capacity(count);
    let component_table = component_table(component);

    for index in 0..count {
        let mut info = unsafe {
            // SAFETY: BusInfo is an SDK POD and getBusInfo initializes every field.
            std::mem::MaybeUninit::<BusInfo>::zeroed().assume_init()
        };
        check("get audio bus info", unsafe {
            // SAFETY: index is within getBusCount for this audio direction and
            // info points to live writable SDK storage.
            ((*component_table).get_bus_info)(
                component.as_ptr(),
                as_media_type(Vst::MediaTypes_kAudio),
                as_bus_direction(direction),
                index as i32,
                std::ptr::addr_of_mut!(info),
            )
        })?;
        let channels = usize::try_from(info.channelCount).map_err(|_| HostError::Operation {
            operation: "audio bus channel count",
            result: -2147024809,
        })?;
        if channels > 64 {
            return Err(HostError::Operation {
                operation: "audio bus channel count",
                result: -2147024809,
            });
        }
        channel_counts.push(channels);
    }

    Ok(build_audio_bus_storage(&channel_counts, input))
}

pub(super) fn audio_bus_descriptors(
    component: &ComPtr<IComponent>,
    direction: BusDirections,
    public_direction: AudioBusDirection,
) -> HostResult<Vec<AudioBusDescriptor>> {
    let count = audio_bus_count(component, direction).max(0);
    let mut buses = Vec::with_capacity(count as usize);
    let table = component_table(component);
    for index in 0..count {
        let mut info = unsafe {
            // SAFETY: BusInfo is an SDK POD and getBusInfo initializes every field.
            std::mem::MaybeUninit::<BusInfo>::zeroed().assume_init()
        };
        check("get audio bus info", unsafe {
            // SAFETY: index is within getBusCount for this audio direction and info is writable.
            ((*table).get_bus_info)(
                component.as_ptr(),
                as_media_type(Vst::MediaTypes_kAudio),
                as_bus_direction(direction),
                index,
                std::ptr::addr_of_mut!(info),
            )
        })?;
        let name_length = info
            .name
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(info.name.len());
        buses.push(AudioBusDescriptor {
            index,
            direction: public_direction,
            kind: if info.busType == as_int32(Vst::BusTypes_kMain) {
                AudioBusKind::Main
            } else {
                AudioBusKind::Aux
            },
            name: String::from_utf16_lossy(&info.name[..name_length]),
            channels: info.channelCount,
            default_active: info.flags & as_uint32(Vst::BusInfo_BusFlags_kDefaultActive) != 0,
        });
    }
    Ok(buses)
}

pub(super) fn build_audio_bus_storage(channel_counts: &[usize], input: bool) -> AudioBusStorage {
    let mut descriptors = Vec::with_capacity(channel_counts.len());
    let mut channel_pointers = Vec::with_capacity(channel_counts.len());
    let mut scratch = Vec::with_capacity(channel_counts.len());

    for &channels in channel_counts {
        let sample_count = channels * MAX_BLOCK_FRAMES as usize;
        let mut bus_scratch = vec![0.0_f32; sample_count];
        let base = bus_scratch.as_mut_ptr();
        let mut bus_channel_pointers = (0..channels)
            .map(|channel| unsafe {
                // SAFETY: sample_count reserves MAX_BLOCK_FRAMES samples for
                // every channel and channel is strictly below channels.
                base.add(channel * MAX_BLOCK_FRAMES as usize)
            })
            .collect::<Vec<_>>();
        let channel_buffers = if bus_channel_pointers.is_empty() {
            std::ptr::null_mut()
        } else {
            bus_channel_pointers.as_mut_ptr()
        };
        descriptors.push(AudioBusBuffers {
            numChannels: channels as i32,
            silenceFlags: if input { silence_flags(channels) } else { 0 },
            __bindgen_anon_1: AudioBusBuffers__bindgen_ty_1 {
                channelBuffers32: channel_buffers,
            },
        });
        channel_pointers.push(bus_channel_pointers);
        scratch.push(bus_scratch);
    }

    AudioBusStorage {
        descriptors,
        channel_pointers,
        scratch,
        input,
    }
}

pub(super) fn validate_main_bus_layout(
    inputs: &AudioBusStorage,
    outputs: &AudioBusStorage,
    kind: PluginKind,
    layout: AudioLayout,
) -> HostResult<()> {
    if kind == PluginKind::Effect
        && inputs.descriptors.first().map(|bus| bus.numChannels) != Some(layout.input_channels())
    {
        return Err(HostError::Operation {
            operation: "main audio input layout",
            result: -2147024809,
        });
    }
    if outputs.descriptors.first().map(|bus| bus.numChannels) != Some(layout.output_channels()) {
        return Err(HostError::Operation {
            operation: "main audio output layout",
            result: -2147024809,
        });
    }
    Ok(())
}

/// Synchronizes the component's bus state with the process buffers Heron can
/// route today: the first main bus is active and every auxiliary bus is not.
///
/// Some commercial multi-out instruments keep their default-active auxiliary
/// busses in their render loop until the host explicitly deactivates them.
/// Leaving those busses implicit while supplying only the main bus lets such a
/// plug-in index beyond the host's `AudioBusBuffers` array.
pub(super) fn configure_audio_bus_activation(
    component: &ComPtr<IComponent>,
    kind: PluginKind,
) -> HostResult<()> {
    let component_table = component_table(component);
    let input_count = audio_bus_count(component, Vst::BusDirections_kInput);
    let output_count = audio_bus_count(component, Vst::BusDirections_kOutput);
    if kind == PluginKind::Effect && input_count == 0 {
        return Err(HostError::Operation {
            operation: "audio input bus count",
            result: -2147024809,
        });
    }
    if output_count == 0 {
        return Err(HostError::Operation {
            operation: "audio output bus count",
            result: -2147024809,
        });
    }

    for index in 0..input_count {
        let active = u8::from(kind == PluginKind::Effect && index == 0);
        check("configure audio input bus", unsafe {
            // SAFETY: index is within getBusCount(kAudio, kInput), and bus
            // activation happens before the component enters the active state.
            ((*component_table).activate_bus)(
                component.as_ptr(),
                as_media_type(Vst::MediaTypes_kAudio),
                as_bus_direction(Vst::BusDirections_kInput),
                index,
                active,
            )
        })?;
    }
    for index in 0..output_count {
        let active = u8::from(index == 0);
        check("configure audio output bus", unsafe {
            // SAFETY: index is within getBusCount(kAudio, kOutput), and bus
            // activation happens before the component enters the active state.
            ((*component_table).activate_bus)(
                component.as_ptr(),
                as_media_type(Vst::MediaTypes_kAudio),
                as_bus_direction(Vst::BusDirections_kOutput),
                index,
                active,
            )
        })?;
    }
    Ok(())
}

pub(super) fn validate_bus_address(
    component: &ComPtr<IComponent>,
    media_type: i32,
    direction: i32,
    index: i32,
) -> HostResult<()> {
    if !(0..=1).contains(&media_type) || !(0..=1).contains(&direction) || index < 0 {
        return Err(HostError::Operation {
            operation: "VST3 bus address",
            result: -2147024809,
        });
    }
    let count = unsafe {
        // SAFETY: media type and direction were validated against the SDK enum ranges.
        ((*component_table(component)).get_bus_count)(component.as_ptr(), media_type, direction)
    };
    if index >= count.max(0) {
        return Err(HostError::Operation {
            operation: "VST3 bus index",
            result: -2147024809,
        });
    }
    Ok(())
}

pub(super) fn apply_bus_activation_overrides(
    component: &ComPtr<IComponent>,
    overrides: &[BusActivationOverride],
) -> HostResult<()> {
    for entry in overrides {
        validate_bus_address(component, entry.media_type, entry.direction, entry.index)?;
        check("IComponent::activateBus", unsafe {
            // SAFETY: the address is valid and this runs while the component is inactive.
            ((*component_table(component)).activate_bus)(
                component.as_ptr(),
                entry.media_type,
                entry.direction,
                entry.index,
                u8::from(entry.active),
            )
        })?;
    }
    Ok(())
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
pub(super) fn negotiate_bus_arrangements(
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

pub(super) fn activate_event_input_buses(component: &ComPtr<IComponent>) -> HostResult<()> {
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

pub(super) fn component_table(component: &ComPtr<IComponent>) -> *const ComponentVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *component.as_ptr().cast::<*const ComponentVTable>()
    }
}

pub(super) fn processor_table(processor: &ComPtr<IAudioProcessor>) -> *const AudioProcessorVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *processor.as_ptr().cast::<*const AudioProcessorVTable>()
    }
}

pub(super) fn presentation_latency_table(
    latency: &ComPtr<IAudioPresentationLatency>,
) -> *const AudioPresentationLatencyVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading matching vtable pointer.
        *latency
            .as_ptr()
            .cast::<*const AudioPresentationLatencyVTable>()
    }
}

pub(super) fn process_context_requirements_table(
    requirements: &ComPtr<IProcessContextRequirements>,
) -> *const ProcessContextRequirementsVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *requirements
            .as_ptr()
            .cast::<*const ProcessContextRequirementsVTable>()
    }
}

pub(super) fn check(operation: &'static str, result: i32) -> HostResult<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(HostError::Operation { operation, result })
    }
}

pub(super) fn check_optional(operation: &'static str, result: i32) -> HostResult<()> {
    // Valid components may inherit a default kNotImplemented implementation.
    // The SDK uses a small sequential result on macOS/Linux and HRESULT-shaped
    // values in its COM-compatible configurations, so accept every SDK encoding.
    // setupProcessing plus setActive still establishes a legal processing
    // lifecycle when an optional hint is ignored.
    const SDK_NOT_IMPLEMENTED: [i32; 3] = [3, 0x8000_4001_u32 as i32, 0x8000_0001_u32 as i32];
    if result == 0 || SDK_NOT_IMPLEMENTED.contains(&result) {
        Ok(())
    } else {
        Err(HostError::Operation { operation, result })
    }
}
