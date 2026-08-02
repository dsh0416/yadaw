use std::{
    ffi::c_void,
    os::raw::c_char,
    sync::atomic::{AtomicU32, Ordering},
};

use yadaw_vst3_host_sys::{
    Steinberg::{FUnknown, Vst::IHostApplication, tresult, uint32},
    abi::{FUnknownVTable, HostApplicationVTable},
    iid,
};

use crate::host_objects::{HostAttributeList, HostMessage};

#[repr(C)]
pub(crate) struct HostContext {
    vtable: *const HostApplicationVTable,
    references: AtomicU32,
}

impl HostContext {
    pub(crate) fn new() -> Box<Self> {
        Box::new(Self {
            vtable: &HOST_APPLICATION_VTABLE,
            references: AtomicU32::new(1),
        })
    }

    pub(crate) fn as_unknown(&self) -> *mut FUnknown {
        std::ptr::from_ref(self).cast_mut().cast()
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
        // SAFETY: VST3 queryInterface always supplies a 16-byte TUID.
        std::slice::from_raw_parts(requested, 16)
    };
    if requested == iid::FUNKNOWN || requested == iid::IHOST_APPLICATION {
        unsafe {
            // SAFETY: output is validated above and this is the same leading
            // interface pointer for FUnknown and IHostApplication.
            output.write(this.cast());
            add_ref(this);
        }
        0
    } else {
        unsafe {
            // SAFETY: output is validated above.
            output.write(std::ptr::null_mut());
        }
        -2147467262
    }
}

unsafe extern "system" fn add_ref(this: *mut FUnknown) -> uint32 {
    let context = this.cast::<HostContext>();
    unsafe {
        // SAFETY: this points to HostContext's leading interface.
        (*context).references.fetch_add(1, Ordering::Relaxed) + 1
    }
}

unsafe extern "system" fn release(this: *mut FUnknown) -> uint32 {
    let context = this.cast::<HostContext>();
    unsafe {
        // SAFETY: ownership remains with StereoProcessor. Plug-ins may balance
        // temporary references but cannot destroy the host-owned object.
        (*context)
            .references
            .fetch_sub(1, Ordering::Release)
            .saturating_sub(1)
    }
}

unsafe extern "system" fn get_name(_this: *mut IHostApplication, name: *mut u16) -> tresult {
    if name.is_null() {
        return -2147024809;
    }
    let encoded = "YADAW\0".encode_utf16();
    for (index, value) in encoded.enumerate() {
        unsafe {
            // SAFETY: VST3 String128 provides at least 128 UTF-16 elements.
            name.add(index).write(value);
        }
    }
    0
}

unsafe extern "system" fn create_instance(
    _this: *mut IHostApplication,
    class_id: *mut c_char,
    interface_id: *mut c_char,
    output: *mut *mut c_void,
) -> tresult {
    if class_id.is_null() || interface_id.is_null() || output.is_null() {
        return -2147024809;
    }
    let class_id = unsafe {
        // SAFETY: VST3 createInstance always supplies a 16-byte class TUID.
        std::slice::from_raw_parts(class_id, 16)
    };
    let interface_id = unsafe {
        // SAFETY: VST3 createInstance always supplies a 16-byte interface TUID.
        std::slice::from_raw_parts(interface_id, 16)
    };
    let instance = if class_id == iid::IMESSAGE && interface_id == iid::IMESSAGE {
        HostMessage::into_raw().cast()
    } else if class_id == iid::IATTRIBUTE_LIST && interface_id == iid::IATTRIBUTE_LIST {
        HostAttributeList::into_raw().cast()
    } else {
        std::ptr::null_mut()
    };
    unsafe {
        // SAFETY: output was validated above and receives one owned reference
        // for supported host-created objects.
        output.write(instance);
    }
    if instance.is_null() { -2147467262 } else { 0 }
}

static HOST_APPLICATION_VTABLE: HostApplicationVTable = HostApplicationVTable {
    base: FUnknownVTable {
        query_interface,
        add_ref,
        release,
    },
    get_name,
    create_instance,
};

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn release_created(object: *mut c_void) {
        let unknown = object.cast::<FUnknown>();
        let vtable = unsafe {
            // SAFETY: createInstance returned a live VST3 object with an FUnknown prefix.
            *unknown.cast::<*const FUnknownVTable>()
        };
        unsafe {
            // SAFETY: createInstance returned exactly one owned reference.
            ((*vtable).release)(unknown);
        }
    }

    #[test]
    fn creates_mandatory_vst3_message_objects() {
        let context = HostContext::new();
        let application = context.as_unknown().cast();
        for interface_id in [iid::IMESSAGE, iid::IATTRIBUTE_LIST] {
            let mut object = std::ptr::null_mut();
            let result = unsafe {
                // SAFETY: the IDs and output storage satisfy createInstance's ABI contract.
                create_instance(
                    application,
                    interface_id.as_ptr().cast_mut(),
                    interface_id.as_ptr().cast_mut(),
                    &mut object,
                )
            };
            assert_eq!(result, 0);
            assert!(!object.is_null());
            unsafe {
                // SAFETY: the successful call returned one owned reference.
                release_created(object);
            }
        }
    }

    #[test]
    fn rejects_unknown_host_objects_without_returning_a_pointer() {
        let context = HostContext::new();
        let mut object = std::ptr::without_provenance_mut(1);
        let result = unsafe {
            // SAFETY: the IDs and output storage satisfy createInstance's ABI contract.
            create_instance(
                context.as_unknown().cast(),
                iid::ICOMPONENT.as_ptr().cast_mut(),
                iid::ICOMPONENT.as_ptr().cast_mut(),
                &mut object,
            )
        };
        assert_eq!(result, -2147467262);
        assert!(object.is_null());
    }
}
