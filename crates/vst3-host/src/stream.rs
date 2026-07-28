use std::{
    ffi::c_void,
    os::raw::c_char,
    sync::atomic::{AtomicU32, Ordering},
};

use yadaw_vst3_host_sys::{
    Steinberg::{FUnknown, IBStream, int32, int64, tresult, uint32},
    abi::{FUnknownVTable, StreamVTable},
    iid,
};

#[repr(C)]
pub(crate) struct MemoryStream {
    vtable: *const StreamVTable,
    references: AtomicU32,
    bytes: Vec<u8>,
    position: usize,
}

impl MemoryStream {
    pub(crate) fn empty() -> Box<Self> {
        Self::from_bytes(Vec::new())
    }

    pub(crate) fn from_slice(bytes: &[u8]) -> Box<Self> {
        Self::from_bytes(bytes.to_vec())
    }

    fn from_bytes(bytes: Vec<u8>) -> Box<Self> {
        Box::new(Self {
            vtable: &STREAM_VTABLE,
            references: AtomicU32::new(1),
            bytes,
            position: 0,
        })
    }

    pub(crate) fn as_interface(&mut self) -> *mut IBStream {
        std::ptr::from_mut(self).cast()
    }

    pub(crate) fn rewind(&mut self) {
        self.position = 0;
    }

    #[expect(
        clippy::boxed_local,
        reason = "the IBStream interface requires a stable allocation until the final FFI call"
    )]
    pub(crate) fn into_bytes(self: Box<Self>) -> Vec<u8> {
        self.bytes
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
    if requested == iid::FUNKNOWN || requested == iid::IBSTREAM {
        unsafe {
            // SAFETY: output is valid and MemoryStream starts with the IBStream vtable pointer.
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
    let stream = this.cast::<MemoryStream>();
    unsafe {
        // SAFETY: this is the leading interface of a live MemoryStream.
        (*stream).references.fetch_add(1, Ordering::Relaxed) + 1
    }
}

unsafe extern "system" fn release(this: *mut FUnknown) -> uint32 {
    let stream = this.cast::<MemoryStream>();
    unsafe {
        // SAFETY: this is the leading interface of a live MemoryStream. The host retains the
        // allocation for the duration of every VST3 call, so the plug-in must not delete it.
        (*stream).references.fetch_sub(1, Ordering::Release) - 1
    }
}

unsafe extern "system" fn read(
    this: *mut IBStream,
    buffer: *mut c_void,
    byte_count: int32,
    bytes_read: *mut int32,
) -> tresult {
    if byte_count < 0 || (byte_count > 0 && buffer.is_null()) {
        return -2147024809;
    }
    let stream = this.cast::<MemoryStream>();
    let stream = unsafe {
        // SAFETY: the interface pointer was created from a live MemoryStream.
        &mut *stream
    };
    let count = (byte_count as usize).min(stream.bytes.len().saturating_sub(stream.position));
    if count > 0 {
        unsafe {
            // SAFETY: the caller provided byte_count writable bytes and count does not exceed it.
            std::ptr::copy_nonoverlapping(
                stream.bytes.as_ptr().add(stream.position),
                buffer.cast::<u8>(),
                count,
            );
        }
    }
    stream.position += count;
    if !bytes_read.is_null() {
        unsafe {
            // SAFETY: the optional output pointer is non-null.
            bytes_read.write(count as int32);
        }
    }
    0
}

unsafe extern "system" fn write(
    this: *mut IBStream,
    buffer: *mut c_void,
    byte_count: int32,
    bytes_written: *mut int32,
) -> tresult {
    if byte_count < 0 || (byte_count > 0 && buffer.is_null()) {
        return -2147024809;
    }
    let stream = this.cast::<MemoryStream>();
    let stream = unsafe {
        // SAFETY: the interface pointer was created from a live MemoryStream.
        &mut *stream
    };
    let count = byte_count as usize;
    let end = match stream.position.checked_add(count) {
        Some(end) => end,
        None => return -2147024882,
    };
    if end > stream.bytes.len() {
        stream.bytes.resize(end, 0);
    }
    if count > 0 {
        unsafe {
            // SAFETY: buffer contains byte_count readable bytes and the destination was resized.
            std::ptr::copy_nonoverlapping(
                buffer.cast::<u8>(),
                stream.bytes.as_mut_ptr().add(stream.position),
                count,
            );
        }
    }
    stream.position = end;
    if !bytes_written.is_null() {
        unsafe {
            // SAFETY: the optional output pointer is non-null.
            bytes_written.write(byte_count);
        }
    }
    0
}

unsafe extern "system" fn seek(
    this: *mut IBStream,
    position: int64,
    mode: int32,
    result: *mut int64,
) -> tresult {
    let stream = this.cast::<MemoryStream>();
    let stream = unsafe {
        // SAFETY: the interface pointer was created from a live MemoryStream.
        &mut *stream
    };
    let base = match mode {
        0 => 0_i64,
        1 => stream.position.min(i64::MAX as usize) as i64,
        2 => stream.bytes.len().min(i64::MAX as usize) as i64,
        _ => return -2147024809,
    };
    let Some(next) = base.checked_add(position) else {
        return -2147024809;
    };
    if next < 0 {
        return -2147024809;
    }
    stream.position = next as usize;
    if !result.is_null() {
        unsafe {
            // SAFETY: the optional output pointer is non-null.
            result.write(next);
        }
    }
    0
}

unsafe extern "system" fn tell(this: *mut IBStream, position: *mut int64) -> tresult {
    if position.is_null() {
        return -2147024809;
    }
    let stream = this.cast::<MemoryStream>();
    let value = unsafe {
        // SAFETY: the interface pointer was created from a live MemoryStream.
        (*stream).position.min(i64::MAX as usize) as i64
    };
    unsafe {
        // SAFETY: output was validated above.
        position.write(value);
    }
    0
}

static STREAM_VTABLE: StreamVTable = StreamVTable {
    base: FUnknownVTable {
        query_interface,
        add_ref,
        release,
    },
    read,
    write,
    seek,
    tell,
};
