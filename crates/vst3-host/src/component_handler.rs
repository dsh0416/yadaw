use std::{
    cell::UnsafeCell,
    ffi::c_void,
    os::raw::c_char,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
};

use bitflags::bitflags;
use ringbuf::{HeapProd, traits::Producer};
use yadaw_vst3_host_sys::{
    Steinberg::{
        FUnknown,
        Vst::{IComponentHandler, ParamID, ParamValue},
        int32, tresult, uint32,
    },
    abi::{ComponentHandlerVTable, FUnknownVTable},
    iid,
};

use crate::processor::QueuedParameter;

pub(crate) struct HandlerShared {
    parameter_producer: UnsafeCell<HeapProd<QueuedParameter>>,
    parameter_mirror: UnsafeCell<Option<Arc<HandlerShared>>>,
    restart_requests: AtomicU32,
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
}

// SAFETY: The only interior mutable field is an SPSC producer. VST3 requires controller and
// component-handler calls on one UI thread, while the consumer lives on the audio thread.
unsafe impl Sync for HandlerShared {}

#[repr(C)]
pub(crate) struct ComponentHandler {
    vtable: *const ComponentHandlerVTable,
    references: AtomicU32,
    shared: Arc<HandlerShared>,
}

impl ComponentHandler {
    pub(crate) fn new(shared: Arc<HandlerShared>) -> Box<Self> {
        Box::new(Self {
            vtable: &COMPONENT_HANDLER_VTABLE,
            references: AtomicU32::new(1),
            shared,
        })
    }

    pub(crate) fn as_interface(&mut self) -> *mut IComponentHandler {
        std::ptr::from_mut(self).cast()
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
        unsafe {
            // SAFETY: output is writable as validated above.
            output.write(std::ptr::null_mut());
        }
        -2147467262
    }
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

unsafe extern "system" fn begin_edit(_this: *mut IComponentHandler, _id: ParamID) -> tresult {
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
        0
    } else {
        1
    }
}

unsafe extern "system" fn end_edit(_this: *mut IComponentHandler, _id: ParamID) -> tresult {
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

#[cfg(test)]
mod tests {
    use ringbuf::{
        HeapRb,
        traits::{Consumer, Split},
    };

    use super::{HandlerShared, Vst3RestartRequest, restart_component};

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
}
