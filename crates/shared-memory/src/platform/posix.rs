use std::{
    ffi::{CStr, CString},
    io,
    num::NonZeroUsize,
    os::fd::{FromRawFd, OwnedFd},
    ptr::NonNull,
    sync::Mutex,
};

use libc::{
    F_SETFD, FD_CLOEXEC, MAP_FAILED, MAP_SHARED, O_CREAT, O_EXCL, O_RDWR, PROT_READ, PROT_WRITE,
    c_void, fcntl, fstat, ftruncate, mmap, munmap, shm_open, shm_unlink, stat,
};

use crate::SharedMemoryError;

pub(crate) struct Mapping {
    address: NonNull<u8>,
    length: NonZeroUsize,
    _fd: OwnedFd,
    owner_name: Mutex<Option<CString>>,
}

// SAFETY: Mapping owns the mapped view and its backing file descriptor. The
// address remains valid until the final Mapping owner drops, no safe byte
// reference is exposed, and unmapping is serialized by Rust ownership.
unsafe impl Send for Mapping {}

// SAFETY: Shared access can only obtain mapping metadata or an unsafe raw
// address. Callers must provide their own atomic protocol before dereferencing
// it, while Drop cannot race because Mapping is held behind the final Arc.
unsafe impl Sync for Mapping {}

impl Mapping {
    pub(crate) fn create(
        object_id: [u8; 16],
        length: NonZeroUsize,
    ) -> Result<Self, SharedMemoryError> {
        let name = object_name(object_id);
        // SAFETY: name is a valid NUL-terminated POSIX shared-memory name and
        // the flags/mode contain no borrowed pointers.
        let raw_fd = unsafe { shm_open(name.as_ptr(), O_CREAT | O_EXCL | O_RDWR, 0o600) };
        if raw_fd < 0 {
            let source = io::Error::last_os_error();
            if source.raw_os_error() == Some(libc::EEXIST) {
                return Err(SharedMemoryError::NameExhausted);
            }
            return Err(SharedMemoryError::os_error("shm_open(create)", source));
        }
        // SAFETY: shm_open returned a new owned file descriptor on success.
        let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        let mut unlink_guard = UnlinkGuard::new(name.clone());
        set_close_on_exec(raw_fd)?;
        let truncate_length = libc::off_t::try_from(length.get())
            .map_err(|_| SharedMemoryError::invalid_descriptor("byte length does not fit off_t"))?;
        // SAFETY: fd is live and truncate_length is a validated non-negative
        // length representable by off_t.
        if unsafe { ftruncate(raw_fd, truncate_length) } != 0 {
            return Err(SharedMemoryError::os("ftruncate"));
        }
        let address = map(raw_fd, length)?;
        unlink_guard.disarm();
        Ok(Self {
            address,
            length,
            _fd: fd,
            owner_name: Mutex::new(Some(name)),
        })
    }

    pub(crate) fn open(
        object_id: [u8; 16],
        length: NonZeroUsize,
    ) -> Result<Self, SharedMemoryError> {
        let name = object_name(object_id);
        // SAFETY: name is a valid NUL-terminated POSIX shared-memory name.
        let raw_fd = unsafe { shm_open(name.as_ptr(), O_RDWR, 0) };
        if raw_fd < 0 {
            return Err(SharedMemoryError::os("shm_open(open)"));
        }
        // SAFETY: shm_open returned a new owned file descriptor on success.
        let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        set_close_on_exec(raw_fd)?;
        verify_length(raw_fd, length)?;
        let address = map(raw_fd, length)?;
        Ok(Self {
            address,
            length,
            _fd: fd,
            owner_name: Mutex::new(None),
        })
    }

    pub(crate) fn address(&self) -> NonNull<u8> {
        self.address
    }

    pub(crate) fn unlink(&self) -> Result<(), SharedMemoryError> {
        let mut owner_name = self
            .owner_name
            .lock()
            .map_err(|_| SharedMemoryError::invalid_descriptor("owner-name lock is poisoned"))?;
        let Some(name) = owner_name.as_ref() else {
            return Ok(());
        };
        unlink_name(name)?;
        *owner_name = None;
        Ok(())
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: address and length came from a successful mmap and this is
        // the final owner of the Mapping value.
        let _ = unsafe { munmap(self.address.as_ptr().cast::<c_void>(), self.length.get()) };
        let owner_name = match self.owner_name.get_mut() {
            Ok(value) => value,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(name) = owner_name.take() {
            let _ = unlink_name(&name);
        }
    }
}

struct UnlinkGuard(Option<CString>);

impl UnlinkGuard {
    fn new(name: CString) -> Self {
        Self(Some(name))
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for UnlinkGuard {
    fn drop(&mut self) {
        if let Some(name) = self.0.take() {
            let _ = unlink_name(&name);
        }
    }
}

fn map(raw_fd: i32, length: NonZeroUsize) -> Result<NonNull<u8>, SharedMemoryError> {
    // SAFETY: raw_fd is a live shared-memory descriptor sized to at least
    // length bytes. A null address lets the kernel select a page-aligned view.
    let address = unsafe {
        mmap(
            std::ptr::null_mut(),
            length.get(),
            PROT_READ | PROT_WRITE,
            MAP_SHARED,
            raw_fd,
            0,
        )
    };
    if address == MAP_FAILED {
        return Err(SharedMemoryError::os("mmap"));
    }
    NonNull::new(address.cast::<u8>()).ok_or_else(|| {
        SharedMemoryError::os_error("mmap", io::Error::other("mmap returned a null address"))
    })
}

fn set_close_on_exec(raw_fd: i32) -> Result<(), SharedMemoryError> {
    // SAFETY: raw_fd is live and F_SETFD accepts the FD_CLOEXEC integer flag.
    if unsafe { fcntl(raw_fd, F_SETFD, FD_CLOEXEC) } == -1 {
        return Err(SharedMemoryError::os("fcntl(FD_CLOEXEC)"));
    }
    Ok(())
}

fn verify_length(raw_fd: i32, expected: NonZeroUsize) -> Result<(), SharedMemoryError> {
    let mut metadata = std::mem::MaybeUninit::<stat>::uninit();
    // SAFETY: raw_fd is live and metadata points to writable storage for stat.
    if unsafe { fstat(raw_fd, metadata.as_mut_ptr()) } != 0 {
        return Err(SharedMemoryError::os("fstat"));
    }
    // SAFETY: fstat succeeded and initialized the complete stat value.
    let metadata = unsafe { metadata.assume_init() };
    let actual = usize::try_from(metadata.st_size).map_err(|_| {
        SharedMemoryError::invalid_descriptor("mapped object length is not representable")
    })?;
    // Darwin reports the size of POSIX shared-memory objects rounded up to its
    // VM page size, while Linux reports the exact ftruncate length.
    let page_size = system_page_size()?;
    let maximum = expected
        .get()
        .checked_add(page_size - 1)
        .map(|value| value / page_size * page_size)
        .ok_or_else(|| {
            SharedMemoryError::invalid_descriptor("rounded mapped object length overflows")
        })?;
    if actual < expected.get() || actual > maximum {
        return Err(SharedMemoryError::invalid_descriptor(
            "mapped object length differs from descriptor",
        ));
    }
    Ok(())
}

fn system_page_size() -> Result<usize, SharedMemoryError> {
    // SAFETY: _SC_PAGESIZE is a valid sysconf query without pointer arguments.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    usize::try_from(page_size)
        .ok()
        .filter(|value| *value != 0 && value.is_power_of_two())
        .ok_or_else(|| SharedMemoryError::os("sysconf(_SC_PAGESIZE)"))
}

fn unlink_name(name: &CStr) -> Result<(), SharedMemoryError> {
    // SAFETY: name is a valid NUL-terminated POSIX shared-memory name.
    if unsafe { shm_unlink(name.as_ptr()) } == 0 {
        return Ok(());
    }
    let source = io::Error::last_os_error();
    if source.raw_os_error() == Some(libc::ENOENT) {
        Ok(())
    } else {
        Err(SharedMemoryError::os_error("shm_unlink", source))
    }
}

fn object_name(object_id: [u8; 16]) -> CString {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    // Darwin limits POSIX shared-memory names to 31 bytes. A 96-bit projection
    // retains ample collision resistance while keeping `/ydw-` + hex below it.
    let mut bytes = Vec::with_capacity(30);
    bytes.extend_from_slice(b"/ydw-");
    for byte in object_id.into_iter().take(12) {
        bytes.push(HEX[usize::from(byte >> 4)]);
        bytes.push(HEX[usize::from(byte & 0x0f)]);
    }
    CString::new(bytes).expect("hex shared-memory name cannot contain NUL")
}
