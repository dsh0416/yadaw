use std::{
    ffi::c_void,
    os::raw::c_char,
    sync::atomic::{AtomicU32, Ordering},
};

use yadaw_vst3_host_sys::{
    Steinberg::{
        FUnknown, IBStream, ISizeableStream,
        Vst::{IAttributeList, IStreamAttributes},
        int32, int64, tresult, uint32,
    },
    abi::{FUnknownVTable, SizeableStreamVTable, StreamAttributesVTable, StreamVTable},
    iid,
};

use crate::host_objects::{HostAttributeList, attribute_release};

#[repr(C)]
struct SizeableStreamInterface {
    vtable: *const SizeableStreamVTable,
    owner: *mut MemoryStream,
}

#[repr(C)]
struct StreamAttributesInterface {
    vtable: *const StreamAttributesVTable,
    owner: *mut MemoryStream,
}

#[repr(C)]
struct SecondaryInterface {
    vtable: *const c_void,
    owner: *mut MemoryStream,
}

#[repr(C)]
pub(crate) struct MemoryStream {
    vtable: *const StreamVTable,
    references: AtomicU32,
    sizeable: SizeableStreamInterface,
    attributes_interface: StreamAttributesInterface,
    bytes: Vec<u8>,
    position: usize,
    file_name: Option<[u16; 128]>,
    attributes: *mut IAttributeList,
}

impl MemoryStream {
    pub(crate) fn empty() -> Box<Self> {
        Self::from_bytes(Vec::new())
    }

    pub(crate) fn from_slice(bytes: &[u8]) -> Box<Self> {
        Self::from_bytes(bytes.to_vec())
    }

    fn from_bytes(bytes: Vec<u8>) -> Box<Self> {
        let mut stream = Box::new(Self {
            vtable: &STREAM_VTABLE,
            references: AtomicU32::new(1),
            sizeable: SizeableStreamInterface {
                vtable: &SIZEABLE_STREAM_VTABLE,
                owner: std::ptr::null_mut(),
            },
            attributes_interface: StreamAttributesInterface {
                vtable: &STREAM_ATTRIBUTES_VTABLE,
                owner: std::ptr::null_mut(),
            },
            bytes,
            position: 0,
            file_name: None,
            attributes: HostAttributeList::project_state(),
        });
        let owner = std::ptr::from_mut(stream.as_mut());
        stream.sizeable.owner = owner;
        stream.attributes_interface.owner = owner;
        stream
    }

    pub(crate) fn as_interface(&mut self) -> *mut IBStream {
        std::ptr::from_mut(self).cast()
    }

    pub(crate) fn rewind(&mut self) {
        self.position = 0;
    }

    pub(crate) fn into_bytes(mut self: Box<Self>) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
}

impl Drop for MemoryStream {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: the stream owns the initial attribute-list reference.
            attribute_release(self.attributes.cast());
        }
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
    } else if requested == iid::ISIZEABLE_STREAM {
        let stream = this.cast::<MemoryStream>();
        unsafe {
            // SAFETY: the embedded interface remains stable with its owning stream.
            output.write(std::ptr::addr_of_mut!((*stream).sizeable).cast());
            add_ref(this);
        }
        0
    } else if requested == iid::ISTREAM_ATTRIBUTES {
        let stream = this.cast::<MemoryStream>();
        unsafe {
            // SAFETY: the embedded interface remains stable with its owning stream.
            output.write(std::ptr::addr_of_mut!((*stream).attributes_interface).cast());
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

unsafe fn secondary_owner(this: *mut FUnknown) -> *mut MemoryStream {
    // SAFETY: every caller receives one of MemoryStream's live embedded secondary interfaces.
    unsafe { (*this.cast::<SecondaryInterface>()).owner }
}

unsafe extern "system" fn secondary_query_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
) -> tresult {
    // SAFETY: this is a live embedded stream interface supplied by VST3.
    let owner = unsafe { secondary_owner(this) };
    if owner.is_null() {
        return -2147467262;
    }
    // SAFETY: owner is the live primary interface and arguments retain queryInterface semantics.
    unsafe { query_interface(owner.cast(), requested, output) }
}

unsafe extern "system" fn secondary_add_ref(this: *mut FUnknown) -> uint32 {
    // SAFETY: the embedded interface stores its live primary stream owner.
    unsafe { add_ref(secondary_owner(this).cast()) }
}

unsafe extern "system" fn secondary_release(this: *mut FUnknown) -> uint32 {
    // SAFETY: the embedded interface stores its live primary stream owner.
    unsafe { release(secondary_owner(this).cast()) }
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

unsafe extern "system" fn get_stream_size(this: *mut ISizeableStream, size: *mut int64) -> tresult {
    if size.is_null() {
        return -2147024809;
    }
    // SAFETY: this callback is installed only on the embedded ISizeableStream interface.
    let owner = unsafe { (*this.cast::<SizeableStreamInterface>()).owner };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(stream) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    let Ok(length) = int64::try_from(stream.bytes.len()) else {
        return -2147024882;
    };
    // SAFETY: the non-null output pointer was validated above.
    unsafe { size.write(length) };
    0
}

unsafe extern "system" fn set_stream_size(this: *mut ISizeableStream, size: int64) -> tresult {
    let Ok(size) = usize::try_from(size) else {
        return -2147024809;
    };
    // SAFETY: this callback is installed only on the embedded ISizeableStream interface.
    let owner = unsafe { (*this.cast::<SizeableStreamInterface>()).owner };
    // SAFETY: the embedded interface cannot outlive its uniquely called host stream.
    let Some(stream) = (unsafe { owner.as_mut() }) else {
        return -2147467262;
    };
    stream.bytes.resize(size, 0);
    0
}

unsafe extern "system" fn get_file_name(this: *mut IStreamAttributes, name: *mut u16) -> tresult {
    if name.is_null() {
        return -2147024809;
    }
    // SAFETY: this callback is installed only on the embedded IStreamAttributes interface.
    let owner = unsafe { (*this.cast::<StreamAttributesInterface>()).owner };
    // SAFETY: the embedded interface cannot outlive its owner.
    let Some(stream) = (unsafe { owner.as_ref() }) else {
        return -2147467262;
    };
    let Some(file_name) = &stream.file_name else {
        // SAFETY: name is the validated String128 output buffer.
        unsafe { name.write(0) };
        return 1;
    };
    // SAFETY: VST3 supplies String128 storage and file_name contains exactly 128 code units.
    unsafe { std::ptr::copy_nonoverlapping(file_name.as_ptr(), name, file_name.len()) };
    0
}

unsafe extern "system" fn get_attributes(this: *mut IStreamAttributes) -> *mut IAttributeList {
    // SAFETY: this callback is installed only on the embedded IStreamAttributes interface.
    let owner = unsafe { (*this.cast::<StreamAttributesInterface>()).owner };
    // SAFETY: the embedded interface cannot outlive its owner; the returned list is borrowed.
    unsafe {
        owner
            .as_ref()
            .map_or(std::ptr::null_mut(), |stream| stream.attributes)
    }
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

static SIZEABLE_STREAM_VTABLE: SizeableStreamVTable = SizeableStreamVTable {
    base: FUnknownVTable {
        query_interface: secondary_query_interface,
        add_ref: secondary_add_ref,
        release: secondary_release,
    },
    get_stream_size,
    set_stream_size,
};

static STREAM_ATTRIBUTES_VTABLE: StreamAttributesVTable = StreamAttributesVTable {
    base: FUnknownVTable {
        query_interface: secondary_query_interface,
        add_ref: secondary_add_ref,
        release: secondary_release,
    },
    get_file_name,
    get_attributes,
};

#[cfg(test)]
mod tests {
    use super::*;
    use yadaw_vst3_host_sys::abi::AttributeListVTable;

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
        // SAFETY: the test owns the stream and balances the queried secondary reference.
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

    #[test]
    fn memory_stream_is_sizeable_and_preserves_position_when_resized() {
        let mut stream = MemoryStream::from_slice(&[1, 2, 3]);
        let unknown = stream.as_interface().cast::<FUnknown>();
        let mut output = std::ptr::null_mut::<c_void>();
        // SAFETY: the test owns the stream and balances the queried secondary reference.
        unsafe {
            assert_eq!(
                query_interface(
                    unknown,
                    iid::ISIZEABLE_STREAM.as_ptr(),
                    std::ptr::addr_of_mut!(output),
                ),
                0
            );
            let sizeable = output.cast::<ISizeableStream>();
            let mut size = -1;
            assert_eq!(get_stream_size(sizeable, &mut size), 0);
            assert_eq!(size, 3);
            assert_eq!(set_stream_size(sizeable, 6), 0);
            assert_eq!(get_stream_size(sizeable, &mut size), 0);
            assert_eq!(size, 6);
            assert_eq!(secondary_release(sizeable.cast()), 1);
        }
        assert_eq!(stream.into_bytes(), vec![1, 2, 3, 0, 0, 0]);
    }

    #[test]
    fn memory_stream_exposes_borrowed_stream_attributes() {
        let mut stream = MemoryStream::empty();
        let unknown = stream.as_interface().cast::<FUnknown>();
        let mut output = std::ptr::null_mut::<c_void>();
        // SAFETY: the test owns the stream and balances the queried secondary reference.
        unsafe {
            assert_eq!(
                query_interface(
                    unknown,
                    iid::ISTREAM_ATTRIBUTES.as_ptr(),
                    std::ptr::addr_of_mut!(output),
                ),
                0
            );
            let attributes_interface = output.cast::<IStreamAttributes>();
            let mut name = [7_u16; 128];
            assert_eq!(get_file_name(attributes_interface, name.as_mut_ptr()), 1);
            assert_eq!(name[0], 0);
            let attributes = get_attributes(attributes_interface);
            assert!(!attributes.is_null());
            let table = *attributes.cast::<*const AttributeListVTable>();
            let mut state_type = [0_u16; 16];
            assert_eq!(
                ((*table).get_string)(
                    attributes,
                    c"StateType".as_ptr(),
                    state_type.as_mut_ptr(),
                    std::mem::size_of_val(&state_type) as u32,
                ),
                0
            );
            assert_eq!(String::from_utf16_lossy(&state_type[..7]), "Project");
            assert_eq!(secondary_release(attributes_interface.cast()), 1);
        }
    }
}
