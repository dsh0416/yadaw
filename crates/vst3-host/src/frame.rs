use std::{
    ffi::c_void,
    os::raw::c_char,
    sync::atomic::{AtomicU32, Ordering},
};

use yadaw_vst3_host_sys::{
    Steinberg::{FUnknown, IPlugFrame, IPlugView, ViewRect, tresult, uint32},
    abi::{FUnknownVTable, PlugFrameVTable},
    iid,
};

#[repr(C)]
pub struct PlugFrame {
    vtable: *const PlugFrameVTable,
    references: AtomicU32,
    resize: Box<dyn FnMut(*mut IPlugView, ViewRect) -> bool>,
}

impl PlugFrame {
    pub fn new(resize: impl FnMut(*mut IPlugView, ViewRect) -> bool + 'static) -> Box<Self> {
        Box::new(Self {
            vtable: &PLUG_FRAME_VTABLE,
            references: AtomicU32::new(1),
            resize: Box::new(resize),
        })
    }

    #[must_use]
    pub fn as_interface(&mut self) -> *mut IPlugFrame {
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
    if requested == iid::FUNKNOWN || requested == iid::IPLUG_FRAME {
        unsafe {
            // SAFETY: output is valid and PlugFrame starts with the interface vtable pointer.
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
    let frame = this.cast::<PlugFrame>();
    unsafe {
        // SAFETY: this is the leading interface of a live PlugFrame.
        (*frame).references.fetch_add(1, Ordering::Relaxed) + 1
    }
}

unsafe extern "system" fn release(this: *mut FUnknown) -> uint32 {
    let frame = this.cast::<PlugFrame>();
    unsafe {
        // SAFETY: the host-owned allocation outlives the attached view and is released only after
        // setFrame(null), so the plug-in cannot delete it through this counter.
        (*frame).references.fetch_sub(1, Ordering::Release) - 1
    }
}

unsafe extern "system" fn resize_view(
    this: *mut IPlugFrame,
    view: *mut IPlugView,
    size: *mut ViewRect,
) -> tresult {
    if view.is_null() || size.is_null() {
        return -2147024809;
    }
    let frame = unsafe {
        // SAFETY: this is the interface pointer of a live PlugFrame.
        &mut *this.cast::<PlugFrame>()
    };
    let size = unsafe {
        // SAFETY: size was validated non-null and points to one SDK ViewRect.
        size.read()
    };
    if (frame.resize)(view, size) { 0 } else { 1 }
}

static PLUG_FRAME_VTABLE: PlugFrameVTable = PlugFrameVTable {
    base: FUnknownVTable {
        query_interface,
        add_ref,
        release,
    },
    resize_view,
};

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    use super::*;

    #[test]
    fn resize_callback_is_synchronous_and_reentrant_storage_is_external() {
        let width = Rc::new(Cell::new(0));
        let observed = width.clone();
        let mut frame = PlugFrame::new(move |_view, size| {
            observed.set(size.right - size.left);
            true
        });
        let mut size = ViewRect {
            left: 0,
            top: 0,
            right: 640,
            bottom: 480,
        };
        let result = unsafe {
            // SAFETY: the test passes stable non-null sentinel view storage and a live ViewRect.
            resize_view(
                frame.as_interface(),
                std::ptr::dangling_mut::<IPlugView>(),
                &mut size,
            )
        };
        assert_eq!(result, 0);
        assert_eq!(width.get(), 640);
    }
}
