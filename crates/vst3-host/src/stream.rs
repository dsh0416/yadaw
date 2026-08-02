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

#[cfg(test)]
mod tests {
    use super::*;

    const INVALID_ARGUMENT: tresult = -2147024809;
    const NO_INTERFACE: tresult = -2147467262;

    #[test]
    fn memory_stream_reads_writes_seeks_and_reports_position() {
        let mut stream = MemoryStream::from_slice(&[1, 2, 3, 4]);
        let interface = stream.as_interface();
        let mut first = [0_u8; 2];
        let mut bytes_read = -1;

        // SAFETY: interface belongs to the live stream, first is writable for two bytes, and the
        // result pointer is valid for one int32.
        let result = unsafe {
            (STREAM_VTABLE.read)(
                interface,
                first.as_mut_ptr().cast(),
                2,
                std::ptr::addr_of_mut!(bytes_read),
            )
        };
        assert_eq!(result, 0);
        assert_eq!(first, [1, 2]);
        assert_eq!(bytes_read, 2);

        let replacement = [9_u8, 8];
        let mut bytes_written = -1;
        // SAFETY: interface belongs to the live stream, replacement is readable for two bytes,
        // and the result pointer is valid for one int32.
        let result = unsafe {
            (STREAM_VTABLE.write)(
                interface,
                replacement.as_ptr().cast_mut().cast(),
                2,
                std::ptr::addr_of_mut!(bytes_written),
            )
        };
        assert_eq!(result, 0);
        assert_eq!(bytes_written, 2);

        let mut position = -1;
        // SAFETY: interface belongs to the live stream and position is writable.
        let result = unsafe { (STREAM_VTABLE.tell)(interface, std::ptr::addr_of_mut!(position)) };
        assert_eq!(result, 0);
        assert_eq!(position, 4);
        stream.rewind();
        assert_eq!(stream.into_bytes(), vec![1, 2, 9, 8]);
    }

    #[test]
    fn memory_stream_supports_sparse_writes_and_eof_reads() {
        let mut stream = MemoryStream::empty();
        let interface = stream.as_interface();
        let mut position = -1;

        // SAFETY: interface belongs to the live stream and position is writable.
        let result =
            unsafe { (STREAM_VTABLE.seek)(interface, 4, 0, std::ptr::addr_of_mut!(position)) };
        assert_eq!(result, 0);
        let byte = [7_u8];
        // SAFETY: interface belongs to the live stream and byte is readable for one byte.
        let result = unsafe {
            (STREAM_VTABLE.write)(
                interface,
                byte.as_ptr().cast_mut().cast(),
                1,
                std::ptr::null_mut(),
            )
        };
        assert_eq!(result, 0);
        let mut eof = [0_u8; 1];
        let mut bytes_read = -1;
        // SAFETY: interface belongs to the live stream, eof is writable for one byte, and the
        // count output is writable.
        let result = unsafe {
            (STREAM_VTABLE.read)(
                interface,
                eof.as_mut_ptr().cast(),
                1,
                std::ptr::addr_of_mut!(bytes_read),
            )
        };
        assert_eq!(result, 0);
        assert_eq!(bytes_read, 0);
        assert_eq!(stream.into_bytes(), vec![0, 0, 0, 0, 7]);
    }

    #[test]
    fn memory_stream_rejects_invalid_arguments_and_seek_modes() {
        let mut stream = MemoryStream::from_slice(&[1, 2]);
        let interface = stream.as_interface();
        let unknown = interface.cast::<FUnknown>();

        // SAFETY: interface and unknown belong to the live stream; every intentionally-null
        // pointer is passed to exercise validation before dereference.
        unsafe {
            assert_eq!(
                (STREAM_VTABLE.read)(interface, std::ptr::null_mut(), 1, std::ptr::null_mut()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                (STREAM_VTABLE.write)(interface, std::ptr::null_mut(), -1, std::ptr::null_mut()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                (STREAM_VTABLE.seek)(interface, -1, 0, std::ptr::null_mut()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                (STREAM_VTABLE.seek)(interface, 0, 99, std::ptr::null_mut()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                (STREAM_VTABLE.tell)(interface, std::ptr::null_mut()),
                INVALID_ARGUMENT
            );
            assert_eq!(
                (STREAM_VTABLE.base.query_interface)(
                    unknown,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                ),
                INVALID_ARGUMENT
            );
        }
    }

    #[test]
    fn memory_stream_exposes_expected_interfaces_and_balances_references() {
        let mut stream = MemoryStream::empty();
        let unknown = stream.as_interface().cast::<FUnknown>();
        let mut output = std::ptr::null_mut::<c_void>();

        // SAFETY: unknown belongs to the live stream, the SDK IIDs contain 16 bytes, and output
        // is writable for one interface pointer.
        let result = unsafe {
            (STREAM_VTABLE.base.query_interface)(
                unknown,
                iid::IBSTREAM.as_ptr(),
                std::ptr::addr_of_mut!(output),
            )
        };
        assert_eq!(result, 0);
        assert_eq!(output, unknown.cast());
        assert_eq!(stream.references.load(Ordering::Relaxed), 2);
        // SAFETY: query_interface returned one owned reference for this live interface.
        assert_eq!(unsafe { (STREAM_VTABLE.base.release)(unknown) }, 1);

        let unsupported = [0 as c_char; 16];
        output = unknown.cast();
        // SAFETY: unknown belongs to the live stream, unsupported contains 16 bytes, and output
        // is writable for one interface pointer.
        let result = unsafe {
            (STREAM_VTABLE.base.query_interface)(
                unknown,
                unsupported.as_ptr(),
                std::ptr::addr_of_mut!(output),
            )
        };
        assert_eq!(result, NO_INTERFACE);
        assert!(output.is_null());
        assert_eq!(stream.references.load(Ordering::Relaxed), 1);
    }
}
