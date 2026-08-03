use std::{
    cell::UnsafeCell,
    collections::VecDeque,
    ffi::{CStr, c_void},
    os::raw::c_char,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

use bitflags::bitflags;
use heron_vst3_host_sys::{
    Steinberg::{
        FIDString, FUnknown, TBool,
        Vst::{
            BusDirection, IComponentHandler, IComponentHandler2, IComponentHandlerBusActivation,
            IUnitHandler, IUnitHandler2, MediaType, ParamID, ParamValue, ProgramListID, UnitID,
        },
        int32, tresult, uint32,
    },
    abi::{
        ComponentHandler2VTable, ComponentHandlerBusActivationVTable, ComponentHandlerVTable,
        FUnknownVTable, UnitHandler2VTable, UnitHandlerVTable,
    },
    iid,
};
use ringbuf::{HeapProd, traits::Producer};

use crate::processor::QueuedParameter;

pub(crate) struct HandlerShared {
    parameter_producer: UnsafeCell<HeapProd<QueuedParameter>>,
    parameter_mirror: UnsafeCell<Option<Arc<HandlerShared>>>,
    restart_requests: AtomicU32,
    editor_gestures: Mutex<VecDeque<EditorParameterGesture>>,
    host_requests: Mutex<VecDeque<Vst3HostRequest>>,
}

const EDITOR_GESTURE_CAPACITY: usize = 1_024;
const HOST_REQUEST_CAPACITY: usize = 256;

/// Parameter gesture reported by a plug-in's native edit controller.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EditorParameterGesture {
    Begin { parameter_id: u32 },
    Perform { parameter_id: u32, normalized: f64 },
    End { parameter_id: u32 },
}

/// Typed requests published by optional VST3 controller-to-host interfaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Vst3HostRequest {
    DirtyChanged(bool),
    OpenEditor {
        view_name: String,
    },
    GroupEditStarted,
    GroupEditFinished,
    BusActivation {
        media_type: i32,
        direction: i32,
        index: i32,
        active: bool,
    },
    UnitSelected {
        unit_id: i32,
    },
    ProgramListChanged {
        list_id: i32,
        program_index: i32,
    },
    UnitByBusChanged,
}

bitflags! {
    /// Typed `IComponentHandler::restartComponent` requests published by a plug-in.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Vst3RestartRequest: u32 {
        const RELOAD_COMPONENT = 1 << 0;
        const IO_CHANGED = 1 << 1;
        const PARAM_VALUES_CHANGED = 1 << 2;
        const LATENCY_CHANGED = 1 << 3;
        const PARAM_TITLES_CHANGED = 1 << 4;
        const MIDI_CC_ASSIGNMENT_CHANGED = 1 << 5;
        const NOTE_EXPRESSION_CHANGED = 1 << 6;
        const IO_TITLES_CHANGED = 1 << 7;
        const PREFETCHABLE_SUPPORT_CHANGED = 1 << 8;
        const ROUTING_INFO_CHANGED = 1 << 9;
        const KEYSWITCH_CHANGED = 1 << 10;
        const PARAM_ID_MAPPING_CHANGED = 1 << 11;
    }
}

impl HandlerShared {
    pub(crate) fn new(parameter_producer: HeapProd<QueuedParameter>) -> Arc<Self> {
        Arc::new(Self {
            parameter_producer: UnsafeCell::new(parameter_producer),
            parameter_mirror: UnsafeCell::new(None),
            restart_requests: AtomicU32::new(0),
            editor_gestures: Mutex::new(VecDeque::with_capacity(EDITOR_GESTURE_CAPACITY)),
            host_requests: Mutex::new(VecDeque::with_capacity(HOST_REQUEST_CAPACITY)),
        })
    }

    pub(crate) fn enqueue_parameter(&self, id: u32, value: f64) -> bool {
        let producer = unsafe {
            // SAFETY: VST3 controller and IComponentHandler calls are serialized on the host UI
            // thread. The matching consumer is exclusively owned by the audio processor.
            &mut *self.parameter_producer.get()
        };
        let queued = producer
            .try_push(QueuedParameter {
                id,
                value,
                sample_offset: 0,
            })
            .is_ok();
        if !queued {
            return false;
        }
        unsafe {
            // SAFETY: the mirror is installed once on the serialized host UI thread before the
            // instance is exposed to editor or automation callbacks, then remains immutable.
            (&*self.parameter_mirror.get())
                .as_ref()
                .is_none_or(|mirror| mirror.enqueue_parameter(id, value))
        }
    }

    pub(crate) fn set_parameter_mirror(&self, mirror: Arc<HandlerShared>) {
        unsafe {
            // SAFETY: dual-mono construction calls this once on the host UI thread before any
            // editor or audio processing can observe the instance.
            *self.parameter_mirror.get() = Some(mirror);
        }
    }

    pub(crate) fn take_restart_requests(&self) -> Vst3RestartRequest {
        Vst3RestartRequest::from_bits_retain(self.restart_requests.swap(0, Ordering::AcqRel))
    }

    fn publish_editor_gesture(&self, gesture: EditorParameterGesture) {
        let Ok(mut gestures) = self.editor_gestures.lock() else {
            return;
        };
        if gestures.len() == EDITOR_GESTURE_CAPACITY {
            gestures.pop_front();
        }
        gestures.push_back(gesture);
    }

    pub(crate) fn take_editor_gestures(&self) -> Vec<EditorParameterGesture> {
        let Ok(mut gestures) = self.editor_gestures.lock() else {
            return Vec::new();
        };
        gestures.drain(..).collect()
    }

    fn publish_host_request(&self, request: Vst3HostRequest) {
        let Ok(mut requests) = self.host_requests.lock() else {
            return;
        };
        if requests.len() == HOST_REQUEST_CAPACITY {
            requests.pop_front();
        }
        requests.push_back(request);
    }

    pub(crate) fn take_host_requests(&self) -> Vec<Vst3HostRequest> {
        let Ok(mut requests) = self.host_requests.lock() else {
            return Vec::new();
        };
        requests.drain(..).collect()
    }
}

// SAFETY: The SPSC producer is only touched by the serialized VST3 UI thread; its consumer lives
// on the audio thread. The gesture queue is independently synchronized by its mutex.
unsafe impl Sync for HandlerShared {}

#[repr(C)]
pub(crate) struct ComponentHandler {
    vtable: *const ComponentHandlerVTable,
    references: AtomicU32,
    shared: Arc<HandlerShared>,
    handler2: ComponentHandler2Interface,
    bus_activation: BusActivationInterface,
    unit_handler: UnitHandlerInterface,
    unit_handler2: UnitHandler2Interface,
}

#[repr(C)]
struct ComponentHandler2Interface {
    vtable: *const ComponentHandler2VTable,
    owner: *mut ComponentHandler,
}

#[repr(C)]
struct BusActivationInterface {
    vtable: *const ComponentHandlerBusActivationVTable,
    owner: *mut ComponentHandler,
}

#[repr(C)]
struct UnitHandlerInterface {
    vtable: *const UnitHandlerVTable,
    owner: *mut ComponentHandler,
}

#[repr(C)]
struct UnitHandler2Interface {
    vtable: *const UnitHandler2VTable,
    owner: *mut ComponentHandler,
}

#[repr(C)]
struct SecondaryInterface {
    vtable: *const c_void,
    owner: *mut ComponentHandler,
}

impl ComponentHandler {
    pub(crate) fn new(shared: Arc<HandlerShared>) -> Box<Self> {
        let mut handler = Box::new(Self {
            vtable: &COMPONENT_HANDLER_VTABLE,
            references: AtomicU32::new(1),
            shared,
            handler2: ComponentHandler2Interface {
                vtable: &COMPONENT_HANDLER2_VTABLE,
                owner: std::ptr::null_mut(),
            },
            bus_activation: BusActivationInterface {
                vtable: &BUS_ACTIVATION_VTABLE,
                owner: std::ptr::null_mut(),
            },
            unit_handler: UnitHandlerInterface {
                vtable: &UNIT_HANDLER_VTABLE,
                owner: std::ptr::null_mut(),
            },
            unit_handler2: UnitHandler2Interface {
                vtable: &UNIT_HANDLER2_VTABLE,
                owner: std::ptr::null_mut(),
            },
        });
        let owner = std::ptr::from_mut(handler.as_mut());
        handler.handler2.owner = owner;
        handler.bus_activation.owner = owner;
        handler.unit_handler.owner = owner;
        handler.unit_handler2.owner = owner;
        handler
    }

    pub(crate) fn as_interface(&mut self) -> *mut IComponentHandler {
        std::ptr::from_mut(self).cast()
    }

    #[cfg(test)]
    fn handler2_ptr(&mut self) -> *mut IComponentHandler2 {
        std::ptr::addr_of_mut!(self.handler2).cast()
    }

    #[cfg(test)]
    fn bus_activation_ptr(&mut self) -> *mut IComponentHandlerBusActivation {
        std::ptr::addr_of_mut!(self.bus_activation).cast()
    }

    #[cfg(test)]
    fn unit_handler_ptr(&mut self) -> *mut IUnitHandler {
        std::ptr::addr_of_mut!(self.unit_handler).cast()
    }

    #[cfg(test)]
    fn unit_handler2_ptr(&mut self) -> *mut IUnitHandler2 {
        std::ptr::addr_of_mut!(self.unit_handler2).cast()
    }
}

unsafe extern "system" fn query_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
) -> tresult {
    if requested.is_null() || output.is_null() {
        return -2147024809;
    }
    let requested = unsafe {
        // SAFETY: VST3 queryInterface supplies a 16-byte TUID.
        std::slice::from_raw_parts(requested, 16)
    };
    if requested == iid::FUNKNOWN || requested == iid::ICOMPONENT_HANDLER {
        unsafe {
            // SAFETY: output is valid and ComponentHandler starts with the interface vtable.
            output.write(this.cast());
            add_ref(this);
        }
        0
    } else {
        let handler = this.cast::<ComponentHandler>();
        let interface: *mut c_void = unsafe {
            // SAFETY: this is the leading interface of a live ComponentHandler.
            if requested == iid::ICOMPONENT_HANDLER2 {
                std::ptr::addr_of_mut!((*handler).handler2).cast()
            } else if requested == iid::ICOMPONENT_HANDLER_BUS_ACTIVATION {
                std::ptr::addr_of_mut!((*handler).bus_activation).cast()
            } else if requested == iid::IUNIT_HANDLER {
                std::ptr::addr_of_mut!((*handler).unit_handler).cast()
            } else if requested == iid::IUNIT_HANDLER2 {
                std::ptr::addr_of_mut!((*handler).unit_handler2).cast()
            } else {
                std::ptr::null_mut()
            }
        };
        if !interface.is_null() {
            unsafe {
                // SAFETY: output is writable and the embedded interface shares handler lifetime.
                output.write(interface);
                add_ref(this);
            }
            return 0;
        }
        unsafe {
            // SAFETY: output is writable as validated above.
            output.write(std::ptr::null_mut());
        }
        -2147467262
    }
}

unsafe fn secondary_owner(this: *mut FUnknown) -> *mut ComponentHandler {
    // SAFETY: every caller receives one of ComponentHandler's live embedded interfaces.
    unsafe { (*this.cast::<SecondaryInterface>()).owner }
}

unsafe extern "system" fn secondary_query_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
) -> tresult {
    // SAFETY: this is a live embedded handler interface supplied by VST3.
    let owner = unsafe { secondary_owner(this) };
    if owner.is_null() {
        return -2147467262;
    }
    // SAFETY: owner is the live primary interface and arguments retain queryInterface semantics.
    unsafe { query_interface(owner.cast(), requested, output) }
}

unsafe extern "system" fn secondary_add_ref(this: *mut FUnknown) -> uint32 {
    // SAFETY: the embedded interface stores its live primary handler owner.
    unsafe { add_ref(secondary_owner(this).cast()) }
}

unsafe extern "system" fn secondary_release(this: *mut FUnknown) -> uint32 {
    // SAFETY: the embedded interface stores its live primary handler owner.
    unsafe { release(secondary_owner(this).cast()) }
}

unsafe extern "system" fn add_ref(this: *mut FUnknown) -> uint32 {
    let handler = this.cast::<ComponentHandler>();
    unsafe {
        // SAFETY: this is the leading interface of a live ComponentHandler.
        (*handler).references.fetch_add(1, Ordering::Relaxed) + 1
    }
}

unsafe extern "system" fn release(this: *mut FUnknown) -> uint32 {
    let handler = this.cast::<ComponentHandler>();
    unsafe {
        // SAFETY: the host allocation outlives the controller reference and is released only after
        // setComponentHandler(null). The counter reflects plug-in ownership but never self-frees.
        (*handler).references.fetch_sub(1, Ordering::Release) - 1
    }
}

unsafe extern "system" fn begin_edit(this: *mut IComponentHandler, id: ParamID) -> tresult {
    let handler = unsafe {
        // SAFETY: this is the interface pointer of a live ComponentHandler.
        &*this.cast::<ComponentHandler>()
    };
    handler
        .shared
        .publish_editor_gesture(EditorParameterGesture::Begin { parameter_id: id });
    0
}

unsafe extern "system" fn perform_edit(
    this: *mut IComponentHandler,
    id: ParamID,
    normalized: ParamValue,
) -> tresult {
    if !normalized.is_finite() || !(0.0..=1.0).contains(&normalized) {
        return -2147024809;
    }
    let handler = unsafe {
        // SAFETY: this is the interface pointer of a live ComponentHandler.
        &*this.cast::<ComponentHandler>()
    };
    if handler.shared.enqueue_parameter(id, normalized) {
        handler
            .shared
            .publish_editor_gesture(EditorParameterGesture::Perform {
                parameter_id: id,
                normalized,
            });
        0
    } else {
        1
    }
}

unsafe extern "system" fn end_edit(this: *mut IComponentHandler, id: ParamID) -> tresult {
    let handler = unsafe {
        // SAFETY: this is the interface pointer of a live ComponentHandler.
        &*this.cast::<ComponentHandler>()
    };
    handler
        .shared
        .publish_editor_gesture(EditorParameterGesture::End { parameter_id: id });
    0
}

unsafe extern "system" fn restart_component(this: *mut IComponentHandler, flags: int32) -> tresult {
    let handler = unsafe {
        // SAFETY: this is the interface pointer of a live ComponentHandler.
        &*this.cast::<ComponentHandler>()
    };
    let Ok(flags) = u32::try_from(flags) else {
        return -2147024809;
    };
    let Some(request) = Vst3RestartRequest::from_bits(flags) else {
        return -2147024809;
    };
    handler
        .shared
        .restart_requests
        .fetch_or(request.bits(), Ordering::AcqRel);
    0
}

fn bool_from_tbool(value: TBool) -> Option<bool> {
    match value {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

unsafe fn handler2_owner(this: *mut IComponentHandler2) -> *mut ComponentHandler {
    // SAFETY: this callback is installed only on ComponentHandler's embedded Handler2 interface.
    unsafe { (*this.cast::<ComponentHandler2Interface>()).owner }
}

unsafe extern "system" fn set_dirty(this: *mut IComponentHandler2, state: TBool) -> tresult {
    let Some(dirty) = bool_from_tbool(state) else {
        return -2147024809;
    };
    // SAFETY: this is the live embedded Handler2 interface supplied by VST3.
    let owner = unsafe { handler2_owner(this) };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(handler) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    handler
        .shared
        .publish_host_request(Vst3HostRequest::DirtyChanged(dirty));
    0
}

unsafe extern "system" fn request_open_editor(
    this: *mut IComponentHandler2,
    name: FIDString,
) -> tresult {
    // SAFETY: this is the live embedded Handler2 interface supplied by VST3.
    let owner = unsafe { handler2_owner(this) };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(handler) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    let view_name = if name.is_null() {
        "editor".to_owned()
    } else {
        // SAFETY: non-null VST3 FIDString values are NUL-terminated.
        unsafe { CStr::from_ptr(name) }
            .to_string_lossy()
            .into_owned()
    };
    handler
        .shared
        .publish_host_request(Vst3HostRequest::OpenEditor { view_name });
    0
}

unsafe extern "system" fn start_group_edit(this: *mut IComponentHandler2) -> tresult {
    // SAFETY: this is the live embedded Handler2 interface supplied by VST3.
    let owner = unsafe { handler2_owner(this) };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(handler) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    handler
        .shared
        .publish_host_request(Vst3HostRequest::GroupEditStarted);
    0
}

unsafe extern "system" fn finish_group_edit(this: *mut IComponentHandler2) -> tresult {
    // SAFETY: this is the live embedded Handler2 interface supplied by VST3.
    let owner = unsafe { handler2_owner(this) };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(handler) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    handler
        .shared
        .publish_host_request(Vst3HostRequest::GroupEditFinished);
    0
}

unsafe extern "system" fn request_bus_activation(
    this: *mut IComponentHandlerBusActivation,
    media_type: MediaType,
    direction: BusDirection,
    index: int32,
    state: TBool,
) -> tresult {
    let Some(active) = bool_from_tbool(state) else {
        return -2147024809;
    };
    if !(0..=1).contains(&media_type) || !(0..=1).contains(&direction) || index < 0 {
        return -2147024809;
    }
    // SAFETY: this callback is installed only on the embedded bus-activation interface.
    let owner = unsafe { (*this.cast::<BusActivationInterface>()).owner };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(handler) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    handler
        .shared
        .publish_host_request(Vst3HostRequest::BusActivation {
            media_type,
            direction,
            index,
            active,
        });
    0
}

unsafe extern "system" fn notify_unit_selection(
    this: *mut IUnitHandler,
    unit_id: UnitID,
) -> tresult {
    // SAFETY: this callback is installed only on the embedded unit-handler interface.
    let owner = unsafe { (*this.cast::<UnitHandlerInterface>()).owner };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(handler) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    handler
        .shared
        .publish_host_request(Vst3HostRequest::UnitSelected { unit_id });
    0
}

unsafe extern "system" fn notify_program_list_change(
    this: *mut IUnitHandler,
    list_id: ProgramListID,
    program_index: int32,
) -> tresult {
    if program_index < -1 {
        return -2147024809;
    }
    // SAFETY: this callback is installed only on the embedded unit-handler interface.
    let owner = unsafe { (*this.cast::<UnitHandlerInterface>()).owner };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(handler) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    handler
        .shared
        .publish_host_request(Vst3HostRequest::ProgramListChanged {
            list_id,
            program_index,
        });
    0
}

unsafe extern "system" fn notify_unit_by_bus_change(this: *mut IUnitHandler2) -> tresult {
    // SAFETY: this callback is installed only on the embedded unit-handler2 interface.
    let owner = unsafe { (*this.cast::<UnitHandler2Interface>()).owner };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(handler) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    handler
        .shared
        .publish_host_request(Vst3HostRequest::UnitByBusChanged);
    0
}

static COMPONENT_HANDLER_VTABLE: ComponentHandlerVTable = ComponentHandlerVTable {
    base: FUnknownVTable {
        query_interface,
        add_ref,
        release,
    },
    begin_edit,
    perform_edit,
    end_edit,
    restart_component,
};

static COMPONENT_HANDLER2_VTABLE: ComponentHandler2VTable = ComponentHandler2VTable {
    base: FUnknownVTable {
        query_interface: secondary_query_interface,
        add_ref: secondary_add_ref,
        release: secondary_release,
    },
    set_dirty,
    request_open_editor,
    start_group_edit,
    finish_group_edit,
};

static BUS_ACTIVATION_VTABLE: ComponentHandlerBusActivationVTable =
    ComponentHandlerBusActivationVTable {
        base: FUnknownVTable {
            query_interface: secondary_query_interface,
            add_ref: secondary_add_ref,
            release: secondary_release,
        },
        request_bus_activation,
    };

static UNIT_HANDLER_VTABLE: UnitHandlerVTable = UnitHandlerVTable {
    base: FUnknownVTable {
        query_interface: secondary_query_interface,
        add_ref: secondary_add_ref,
        release: secondary_release,
    },
    notify_unit_selection,
    notify_program_list_change,
};

static UNIT_HANDLER2_VTABLE: UnitHandler2VTable = UnitHandler2VTable {
    base: FUnknownVTable {
        query_interface: secondary_query_interface,
        add_ref: secondary_add_ref,
        release: secondary_release,
    },
    notify_unit_by_bus_change,
};

#[cfg(test)]
mod tests {
    use ringbuf::{
        HeapRb,
        traits::{Consumer, Split},
    };

    use super::{
        EditorParameterGesture, HandlerShared, Vst3RestartRequest, begin_edit, end_edit,
        perform_edit, restart_component,
    };

    #[test]
    fn parameter_mirror_queues_the_same_change_for_both_mono_processors() {
        let primary_ring = HeapRb::new(8);
        let (primary_producer, mut primary_consumer) = primary_ring.split();
        let secondary_ring = HeapRb::new(8);
        let (secondary_producer, mut secondary_consumer) = secondary_ring.split();
        let primary = HandlerShared::new(primary_producer);
        let secondary = HandlerShared::new(secondary_producer);
        primary.set_parameter_mirror(secondary);

        assert!(primary.enqueue_parameter(42, 0.75));
        let primary_change = primary_consumer.try_pop().unwrap();
        let secondary_change = secondary_consumer.try_pop().unwrap();
        assert_eq!(primary_change.id, secondary_change.id);
        assert_eq!(primary_change.value, secondary_change.value);
    }

    #[test]
    fn native_editor_gestures_are_drained_in_order() {
        let ring = HeapRb::new(8);
        let (producer, mut consumer) = ring.split();
        let shared = HandlerShared::new(producer);
        let mut handler = super::ComponentHandler::new(shared.clone());
        unsafe {
            // SAFETY: handler owns a live interface for this complete gesture sequence.
            assert_eq!(begin_edit(handler.as_interface(), 42), 0);
            assert_eq!(perform_edit(handler.as_interface(), 42, 0.75), 0);
            assert_eq!(end_edit(handler.as_interface(), 42), 0);
        }
        assert_eq!(consumer.try_pop().unwrap().value, 0.75);
        assert_eq!(
            shared.take_editor_gestures(),
            vec![
                EditorParameterGesture::Begin { parameter_id: 42 },
                EditorParameterGesture::Perform {
                    parameter_id: 42,
                    normalized: 0.75,
                },
                EditorParameterGesture::End { parameter_id: 42 },
            ]
        );
        assert!(shared.take_editor_gestures().is_empty());
    }

    #[test]
    fn restart_component_uses_the_sdk_latency_bit_and_preserves_all_known_flags() {
        let ring = HeapRb::new(8);
        let (producer, _consumer) = ring.split();
        let shared = HandlerShared::new(producer);
        let mut handler = super::ComponentHandler::new(shared.clone());
        let flags = (Vst3RestartRequest::LATENCY_CHANGED
            | Vst3RestartRequest::PARAM_TITLES_CHANGED
            | Vst3RestartRequest::ROUTING_INFO_CHANGED)
            .bits();
        let result = unsafe {
            // SAFETY: handler owns a live interface for the duration of this direct ABI call.
            restart_component(handler.as_interface(), flags as i32)
        };
        assert_eq!(result, 0);
        let request = shared.take_restart_requests();
        assert!(request.contains(Vst3RestartRequest::LATENCY_CHANGED));
        assert!(request.contains(Vst3RestartRequest::PARAM_TITLES_CHANGED));
        assert!(request.contains(Vst3RestartRequest::ROUTING_INFO_CHANGED));
    }

    #[test]
    fn restart_component_accepts_every_sdk_flag_and_rejects_reserved_bits() {
        let ring = HeapRb::new(8);
        let (producer, _consumer) = ring.split();
        let shared = HandlerShared::new(producer);
        let mut handler = super::ComponentHandler::new(shared.clone());
        let accepted = unsafe {
            // SAFETY: handler owns a live interface for the duration of this direct ABI call.
            restart_component(
                handler.as_interface(),
                Vst3RestartRequest::all().bits() as i32,
            )
        };
        assert_eq!(accepted, 0);
        assert_eq!(
            shared.take_restart_requests().bits(),
            Vst3RestartRequest::all().bits()
        );

        let rejected = unsafe {
            // SAFETY: same live handler; the reserved bit is intentionally invalid input.
            restart_component(handler.as_interface(), (1_u32 << 31) as i32)
        };
        assert_ne!(rejected, 0);
        assert!(shared.take_restart_requests().is_empty());
    }

    #[test]
    fn optional_handler_interfaces_publish_typed_requests() {
        let ring = HeapRb::new(8);
        let (producer, _consumer) = ring.split();
        let shared = HandlerShared::new(producer);
        let mut handler = super::ComponentHandler::new(shared.clone());

        unsafe {
            // SAFETY: every embedded interface belongs to the same live boxed handler.
            assert_eq!(super::set_dirty(handler.handler2_ptr(), 1), 0);
            assert_eq!(
                super::request_open_editor(handler.handler2_ptr(), std::ptr::null()),
                0
            );
            assert_eq!(super::start_group_edit(handler.handler2_ptr()), 0);
            assert_eq!(
                super::request_bus_activation(handler.bus_activation_ptr(), 0, 1, 2, 1),
                0
            );
            assert_eq!(
                super::notify_unit_selection(handler.unit_handler_ptr(), 7),
                0
            );
            assert_eq!(
                super::notify_program_list_change(handler.unit_handler_ptr(), 4, -1),
                0
            );
            assert_eq!(
                super::notify_unit_by_bus_change(handler.unit_handler2_ptr()),
                0
            );
            assert_eq!(super::finish_group_edit(handler.handler2_ptr()), 0);
        }

        assert_eq!(
            shared.take_host_requests(),
            vec![
                super::Vst3HostRequest::DirtyChanged(true),
                super::Vst3HostRequest::OpenEditor {
                    view_name: "editor".to_owned(),
                },
                super::Vst3HostRequest::GroupEditStarted,
                super::Vst3HostRequest::BusActivation {
                    media_type: 0,
                    direction: 1,
                    index: 2,
                    active: true,
                },
                super::Vst3HostRequest::UnitSelected { unit_id: 7 },
                super::Vst3HostRequest::ProgramListChanged {
                    list_id: 4,
                    program_index: -1,
                },
                super::Vst3HostRequest::UnitByBusChanged,
                super::Vst3HostRequest::GroupEditFinished,
            ]
        );
    }

    #[test]
    fn query_interface_exposes_each_optional_handler_with_shared_identity() {
        let ring = HeapRb::new(8);
        let (producer, _consumer) = ring.split();
        let shared = HandlerShared::new(producer);
        let mut handler = super::ComponentHandler::new(shared);
        let unknown = handler.as_interface().cast();

        for interface_id in [
            heron_vst3_host_sys::iid::ICOMPONENT_HANDLER2,
            heron_vst3_host_sys::iid::ICOMPONENT_HANDLER_BUS_ACTIVATION,
            heron_vst3_host_sys::iid::IUNIT_HANDLER,
            heron_vst3_host_sys::iid::IUNIT_HANDLER2,
        ] {
            let mut output = std::ptr::null_mut();
            // SAFETY: unknown is the live leading interface and output is writable.
            let result =
                unsafe { super::query_interface(unknown, interface_id.as_ptr(), &mut output) };
            assert_eq!(result, 0);
            assert!(!output.is_null());
            let mut canonical = std::ptr::null_mut();
            // SAFETY: output is a queried live secondary interface and canonical is writable.
            let result = unsafe {
                super::secondary_query_interface(
                    output.cast(),
                    heron_vst3_host_sys::iid::FUNKNOWN.as_ptr(),
                    &mut canonical,
                )
            };
            assert_eq!(result, 0);
            assert_eq!(canonical, unknown.cast());
            // SAFETY: both references were returned owned by successful queryInterface calls.
            unsafe {
                super::secondary_release(output.cast());
                super::release(canonical.cast());
            }
        }
        assert_eq!(
            handler
                .references
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }
}
