use std::{
    cell::UnsafeCell,
    ffi::c_void,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
};

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
    latency_changed: AtomicBool,
}

impl HandlerShared {
    pub(crate) fn new(parameter_producer: HeapProd<QueuedParameter>) -> Arc<Self> {
        Arc::new(Self {
            parameter_producer: UnsafeCell::new(parameter_producer),
            latency_changed: AtomicBool::new(false),
        })
    }

    pub(crate) fn enqueue_parameter(&self, id: u32, value: f64) -> bool {
        let producer = unsafe {
            // SAFETY: VST3 controller and IComponentHandler calls are serialized on the host UI
            // thread. The matching consumer is exclusively owned by the audio processor.
            &mut *self.parameter_producer.get()
        };
        producer
            .try_push(QueuedParameter {
                id,
                value,
                sample_offset: 0,
            })
            .is_ok()
    }

    pub(crate) fn take_latency_changed(&self) -> bool {
        self.latency_changed.swap(false, Ordering::AcqRel)
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
    requested: *const i8,
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
    const LATENCY_CHANGED: i32 = 1 << 4;
    if flags & LATENCY_CHANGED != 0 {
        handler
            .shared
            .latency_changed
            .store(true, Ordering::Release);
    }
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
