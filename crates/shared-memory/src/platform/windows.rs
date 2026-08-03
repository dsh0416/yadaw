use std::{ffi::c_void, io, num::NonZeroUsize, ptr::NonNull};

use windows::{
    Win32::{
        Foundation::{
            CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
        },
        System::Memory::{
            CreateFileMappingW, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
            OpenFileMappingW, PAGE_READWRITE, UnmapViewOfFile,
        },
    },
    core::PCWSTR,
};

use crate::{SharedMemoryError, platform::object_key};

pub(crate) struct Mapping {
    address: NonNull<u8>,
    _handle: SectionHandle,
}

// SAFETY: Mapping owns the mapped view and section handle. The address remains
// valid until the final Mapping owner drops, and no safe byte reference is
// exposed by this platform type.
unsafe impl Send for Mapping {}

// SAFETY: shared access only exposes metadata or an unsafe raw address. The
// caller must synchronize byte access, and Rust ownership serializes unmapping.
unsafe impl Sync for Mapping {}

impl Mapping {
    pub(crate) fn create(
        object_id: [u8; 16],
        length: NonZeroUsize,
        generation: u64,
    ) -> Result<Self, SharedMemoryError> {
        let name = object_name(object_id, length, generation);
        let length_u64 = u64::try_from(length.get())
            .map_err(|_| SharedMemoryError::invalid_descriptor("byte length exceeds u64"))?;
        let high = u32::try_from(length_u64 >> 32)
            .map_err(|_| SharedMemoryError::invalid_descriptor("byte length exceeds u64"))?;
        let low = u32::try_from(length_u64 & u64::from(u32::MAX))
            .expect("masked mapping length always fits u32");
        // SAFETY: INVALID_HANDLE_VALUE requests a page-file-backed section, the
        // UTF-16 name is NUL-terminated, and the size halves cover length.
        let handle = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                high,
                low,
                PCWSTR(name.as_ptr()),
            )
        }
        .map_err(|source| {
            SharedMemoryError::os_error("CreateFileMappingW", windows_error(source))
        })?;
        let handle = SectionHandle(handle);
        // SAFETY: GetLastError reads the calling thread's last-error slot
        // immediately after CreateFileMappingW succeeded.
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Err(SharedMemoryError::NameExhausted);
        }
        Self::from_handle(handle, length)
    }

    pub(crate) fn open(
        object_id: [u8; 16],
        length: NonZeroUsize,
        generation: u64,
    ) -> Result<Self, SharedMemoryError> {
        let name = object_name(object_id, length, generation);
        // SAFETY: the UTF-16 name is NUL-terminated and no borrowed buffer is
        // retained by OpenFileMappingW.
        let handle =
            unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, PCWSTR(name.as_ptr())) }
                .map_err(|source| {
                    SharedMemoryError::os_error("OpenFileMappingW", windows_error(source))
                })?;
        Self::from_handle(SectionHandle(handle), length)
    }

    fn from_handle(handle: SectionHandle, length: NonZeroUsize) -> Result<Self, SharedMemoryError> {
        // SAFETY: handle names a live page-file section and length is non-zero.
        // A requested view larger than the section fails instead of producing a
        // short mapping.
        let view = unsafe { MapViewOfFile(handle.0, FILE_MAP_ALL_ACCESS, 0, 0, length.get()) };
        let address = NonNull::new(view.Value.cast::<u8>()).ok_or_else(|| {
            SharedMemoryError::os_error("MapViewOfFile", io::Error::last_os_error())
        })?;
        Ok(Self {
            address,
            _handle: handle,
        })
    }

    pub(crate) fn address(&self) -> NonNull<u8> {
        self.address
    }

    pub(crate) fn unlink(&self) -> Result<(), SharedMemoryError> {
        Ok(())
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: address came from MapViewOfFile and this is its final owner.
        let _ = unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.address.as_ptr().cast::<c_void>(),
            })
        };
    }
}

struct SectionHandle(HANDLE);

impl Drop for SectionHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was returned by a successful mapping call and is
        // closed exactly once by this owner.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn object_name(object_id: [u8; 16], length: NonZeroUsize, generation: u64) -> Vec<u16> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = Vec::with_capacity(16 + object_id.len() * 2);
    bytes.extend_from_slice(b"Local\\Heron-shm-");
    for byte in object_key(object_id, length, generation) {
        bytes.push(HEX[usize::from(byte >> 4)]);
        bytes.push(HEX[usize::from(byte & 0x0f)]);
    }
    bytes.push(0);
    bytes.into_iter().map(u16::from).collect()
}

fn windows_error(source: windows::core::Error) -> io::Error {
    io::Error::other(source)
}
