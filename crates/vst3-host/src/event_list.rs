use std::{ffi::c_void, mem::MaybeUninit, os::raw::c_char};

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
    requested: *const c_char,
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
    // SAFETY: processor receives the EventList interface created above.
    let len = unsafe { (*list).len };
    if index as usize >= len {
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

#[cfg(test)]
mod tests {
    use super::*;

    const INVALID_ARGUMENT: tresult = -2147024809;
    const NO_INTERFACE: tresult = -2147467262;
    const NOT_IMPLEMENTED: tresult = -2147467263;

    fn zero_event() -> Event {
        // SAFETY: the generated VST3 Event is a C data carrier made only of integer/floating
        // fields and a C union whose all-zero representation is valid.
        unsafe { MaybeUninit::<Event>::zeroed().assume_init() }
    }

    #[test]
    fn event_list_enforces_capacity_and_clear_reuses_storage() {
        let mut list = EventList::new();
        let event = zero_event();
        for _ in 0..EVENT_CAPACITY {
            assert!(list.push(event));
        }
        assert!(!list.push(event));
        assert!(!list.is_empty());

        list.clear();

        assert!(list.is_empty());
        assert!(list.push(event));
    }

    #[test]
    fn event_list_vtable_reports_count_and_copies_initialized_events() {
        let mut list = EventList::new();
        let mut expected = zero_event();
        expected.busIndex = 3;
        expected.sampleOffset = 17;
        assert!(list.push(expected));
        let interface = list.as_interface();
        let mut output = zero_event();

        // SAFETY: interface belongs to the live list and output is writable for one Event.
        assert_eq!(unsafe { (EVENT_LIST_VTABLE.event_count)(interface) }, 1);
        // SAFETY: index zero is initialized and output is writable for one Event.
        let result =
            unsafe { (EVENT_LIST_VTABLE.event)(interface, 0, std::ptr::addr_of_mut!(output)) };
        assert_eq!(result, 0);
        assert_eq!(output.busIndex, 3);
        assert_eq!(output.sampleOffset, 17);
    }

    #[test]
    fn event_list_vtable_rejects_invalid_indices_and_mutation() {
        let mut list = EventList::new();
        let interface = list.as_interface();
        let mut output = zero_event();
        let mut input = zero_event();

        // SAFETY: interface belongs to the live list; invalid arguments are checked before any
        // event storage is read or written.
        unsafe {
            assert_eq!(
                (EVENT_LIST_VTABLE.event)(interface, -1, std::ptr::addr_of_mut!(output),),
                INVALID_ARGUMENT
            );
            assert_eq!(
                (EVENT_LIST_VTABLE.event)(interface, 0, std::ptr::null_mut()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                (EVENT_LIST_VTABLE.event)(interface, 0, std::ptr::addr_of_mut!(output),),
                1
            );
            assert_eq!(
                (EVENT_LIST_VTABLE.add_event)(interface, std::ptr::addr_of_mut!(input),),
                NOT_IMPLEMENTED
            );
        }
    }

    #[test]
    fn event_list_exposes_only_the_event_list_and_unknown_interfaces() {
        let mut list = EventList::new();
        let unknown = list.as_interface().cast::<FUnknown>();
        let mut output = std::ptr::null_mut::<c_void>();

        // SAFETY: unknown belongs to the live list, the IID contains 16 bytes, and output is
        // writable for one interface pointer.
        let result = unsafe {
            (EVENT_LIST_VTABLE.base.query_interface)(
                unknown,
                iid::IEVENT_LIST.as_ptr(),
                std::ptr::addr_of_mut!(output),
            )
        };
        assert_eq!(result, 0);
        assert_eq!(output, unknown.cast());
        let unsupported = [0 as c_char; 16];
        output = unknown.cast();
        // SAFETY: unknown belongs to the live list, unsupported contains 16 bytes, and output is
        // writable for one interface pointer.
        let result = unsafe {
            (EVENT_LIST_VTABLE.base.query_interface)(
                unknown,
                unsupported.as_ptr(),
                std::ptr::addr_of_mut!(output),
            )
        };
        assert_eq!(result, NO_INTERFACE);
        assert!(output.is_null());
    }
}
