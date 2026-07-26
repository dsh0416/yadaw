use std::{ffi::c_void, mem::MaybeUninit};

use yadaw_vst3_host_sys::{
    Steinberg::{
        FUnknown,
        Vst::{Event, IEventList},
        int32, tresult, uint32,
    },
    abi::{EventListVTable, FUnknownVTable},
    iid,
};

pub(crate) const EVENT_CAPACITY: usize = 256;

#[repr(C)]
pub(crate) struct EventList {
    vtable: *const EventListVTable,
    events: [MaybeUninit<Event>; EVENT_CAPACITY],
    len: usize,
}

impl EventList {
    pub(crate) fn new() -> Box<Self> {
        Box::new(Self {
            vtable: &EVENT_LIST_VTABLE,
            events: [const { MaybeUninit::uninit() }; EVENT_CAPACITY],
            len: 0,
        })
    }

    pub(crate) fn push(&mut self, event: Event) -> bool {
        let Some(slot) = self.events.get_mut(self.len) else {
            return false;
        };
        slot.write(event);
        self.len += 1;
        true
    }

    pub(crate) fn clear(&mut self) {
        self.len = 0;
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub(crate) fn as_interface(&mut self) -> *mut IEventList {
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
        // SAFETY: queryInterface supplies a 16-byte TUID.
        std::slice::from_raw_parts(requested, 16)
    };
    if requested == iid::FUNKNOWN || requested == iid::IEVENT_LIST {
        unsafe {
            // SAFETY: output is valid and EventList has the shared interface
            // pointer at offset zero.
            output.write(this.cast());
        }
        0
    } else {
        unsafe {
            // SAFETY: output is valid.
            output.write(std::ptr::null_mut());
        }
        -2147467262
    }
}

unsafe extern "system" fn add_ref(_this: *mut FUnknown) -> uint32 {
    1
}

unsafe extern "system" fn release(_this: *mut FUnknown) -> uint32 {
    1
}

unsafe extern "system" fn event_count(this: *mut IEventList) -> int32 {
    let list = this.cast::<EventList>();
    unsafe {
        // SAFETY: processor receives the EventList interface created above.
        (*list).len.min(i32::MAX as usize) as i32
    }
}

unsafe extern "system" fn event(
    this: *mut IEventList,
    index: int32,
    output: *mut Event,
) -> tresult {
    if index < 0 || output.is_null() {
        return -2147024809;
    }
    let list = this.cast::<EventList>();
    let Some(value) = (unsafe {
        // SAFETY: processor receives the EventList interface created above.
        (*list).events.get(index as usize)
    }) else {
        return 1;
    };
    if index as usize >= unsafe { (*list).len } {
        return 1;
    }
    unsafe {
        // SAFETY: entries below len were initialized by push and output is
        // writable plug-in storage.
        output.write(value.assume_init());
    }
    0
}

unsafe extern "system" fn add_event(_this: *mut IEventList, _event: *mut Event) -> tresult {
    -2147467263
}

static EVENT_LIST_VTABLE: EventListVTable = EventListVTable {
    base: FUnknownVTable {
        query_interface,
        add_ref,
        release,
    },
    event_count,
    event,
    add_event,
};
