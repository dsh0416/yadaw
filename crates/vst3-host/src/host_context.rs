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
    _class_id: *mut c_char,
    _interface_id: *mut c_char,
    output: *mut *mut c_void,
) -> tresult {
    if !output.is_null() {
        unsafe {
            // SAFETY: output was checked before writing.
            output.write(std::ptr::null_mut());
        }
    }
    -2147467262
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
