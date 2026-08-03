use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
    ptr,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

const MARKER_BYTES: u64 = 40;
const MAGIC: u64 = 0x5941_4441_5756_5354;
const CHECKSUM_SALT: u64 = 0x4352_4153_484D_4152;

pub const STAGE_CLEAN: u64 = 0;
pub const STAGE_PROCESS: u64 = 3;

struct CrashMarker {
    pointer: *mut u8,
    #[cfg(windows)]
    mapping: *mut std::ffi::c_void,
    #[cfg(unix)]
    length: usize,
}

// SAFETY: CrashMarker owns a process-lifetime shared mapping. Access to its contents is
// synchronized exclusively through AtomicU64 operations.
unsafe impl Send for CrashMarker {}
// SAFETY: The mapped pointer is stable, and every concurrent read or write uses atomics.
unsafe impl Sync for CrashMarker {}

impl CrashMarker {
    fn atomic(&self, offset: usize) -> &AtomicU64 {
        // SAFETY: The mapping is page-aligned, the offsets are u64-aligned and remain mapped
        // for the process lifetime.
        unsafe { AtomicU64::from_ptr(self.pointer.add(offset).cast::<u64>()) }
    }

    fn write(&self, generation: u64, plugin_index: u64, stage: u64) {
        self.atomic(0).store(MAGIC, Ordering::Relaxed);
        self.atomic(8).store(generation, Ordering::Relaxed);
        self.atomic(16).store(plugin_index, Ordering::Relaxed);
        self.atomic(24).store(stage, Ordering::Release);
        self.atomic(32).store(
            MAGIC ^ generation ^ plugin_index ^ stage ^ CHECKSUM_SALT,
            Ordering::Release,
        );
    }
}

#[cfg(windows)]
impl Drop for CrashMarker {
    fn drop(&mut self) {
        // SAFETY: Both handles were returned by the matching mapping APIs and remain exclusively
        // owned by this CrashMarker until drop.
        unsafe {
            UnmapViewOfFile(self.pointer.cast());
            CloseHandle(self.mapping);
        }
    }
}

#[cfg(unix)]
impl Drop for CrashMarker {
    fn drop(&mut self) {
        // SAFETY: The address and length are the unchanged values returned by mmap and are owned
        // by this CrashMarker until drop.
        unsafe {
            munmap(self.pointer.cast(), self.length);
        }
    }
}

static MARKER: OnceLock<CrashMarker> = OnceLock::new();

pub fn initialize(path: &Path) -> io::Result<()> {
    let file = open_marker_file(path)?;
    let marker = map_file(&file)?;
    marker.write(0, u64::MAX, STAGE_CLEAN);
    MARKER.set(marker).map_err(|_| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "crash marker already initialized",
        )
    })
}

fn open_marker_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    // Never truncate an existing marker. On Windows, recovery can begin while
    // the kernel is still releasing the previous helper's mapped section, and
    // truncation then fails with ERROR_USER_MAPPED_FILE. Only grow a new or
    // incomplete file; the mapping below intentionally uses the first 40 bytes.
    if file.metadata()?.len() < MARKER_BYTES {
        file.set_len(MARKER_BYTES)?;
    }
    Ok(file)
}

pub fn mark(generation: u64, plugin_index: usize, stage: u64) {
    if let Some(marker) = MARKER.get() {
        marker.write(generation, plugin_index as u64, stage);
    }
}

pub fn clean(generation: u64) {
    if let Some(marker) = MARKER.get() {
        marker.write(generation, u64::MAX, STAGE_CLEAN);
    }
}

#[cfg(windows)]
fn map_file(file: &std::fs::File) -> io::Result<CrashMarker> {
    use std::os::windows::io::AsRawHandle;

    // SAFETY: The file handle is live for the call, the mapping is unnamed, and its requested
    // length matches the file length established by initialize.
    let mapping = unsafe {
        CreateFileMappingW(
            file.as_raw_handle(),
            ptr::null(),
            PAGE_READWRITE,
            0,
            MARKER_BYTES as u32,
            ptr::null(),
        )
    };
    if mapping.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: mapping is a valid handle returned above and the requested view is within its
    // MARKER_BYTES extent.
    let pointer =
        unsafe { MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, MARKER_BYTES as usize) };
    if pointer.is_null() {
        // SAFETY: mapping is still owned locally because MapViewOfFile failed.
        unsafe {
            CloseHandle(mapping);
        }
        return Err(io::Error::last_os_error());
    }
    Ok(CrashMarker {
        pointer: pointer.cast(),
        mapping,
    })
}

#[cfg(windows)]
const PAGE_READWRITE: u32 = 0x04;
#[cfg(windows)]
const FILE_MAP_ALL_ACCESS: u32 = 0x000F_001F;

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileMappingW(
        file: *mut std::ffi::c_void,
        attributes: *const std::ffi::c_void,
        protect: u32,
        maximum_size_high: u32,
        maximum_size_low: u32,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn MapViewOfFile(
        mapping: *mut std::ffi::c_void,
        access: u32,
        offset_high: u32,
        offset_low: u32,
        bytes: usize,
    ) -> *mut std::ffi::c_void;
    fn UnmapViewOfFile(address: *const std::ffi::c_void) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(unix)]
fn map_file(file: &std::fs::File) -> io::Result<CrashMarker> {
    use std::os::fd::AsRawFd;

    // SAFETY: The descriptor is live for the call, the file was extended to MARKER_BYTES, and the
    // returned mapping is checked against MAP_FAILED before use.
    let pointer = unsafe {
        mmap(
            ptr::null_mut(),
            MARKER_BYTES as usize,
            PROT_READ | PROT_WRITE,
            MAP_SHARED,
            file.as_raw_fd(),
            0,
        )
    };
    if pointer as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(CrashMarker {
        pointer: pointer.cast(),
        length: MARKER_BYTES as usize,
    })
}

#[cfg(unix)]
const PROT_READ: i32 = 0x1;
#[cfg(unix)]
const PROT_WRITE: i32 = 0x2;
#[cfg(unix)]
const MAP_SHARED: i32 = 0x01;

#[cfg(unix)]
unsafe extern "C" {
    fn mmap(
        address: *mut std::ffi::c_void,
        length: usize,
        protection: i32,
        flags: i32,
        file: i32,
        offset: isize,
    ) -> *mut std::ffi::c_void;
    fn munmap(address: *mut std::ffi::c_void, length: usize) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Process-global MARKER must be exercised serially across these tests.
    static CRASH_MARKER_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn marker_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "heron-crash-marker-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock must follow the Unix epoch")
                .as_nanos()
        ))
    }

    fn ensure_initialized(path: &Path) {
        if MARKER.get().is_none() {
            initialize(path).expect("crash marker must initialize once per process");
        }
    }

    #[test]
    fn opens_a_marker_while_an_existing_view_is_mapped() {
        let path = marker_path("mapped");
        let original = open_marker_file(&path).expect("test marker must open");
        let mapping = map_file(&original).expect("test marker must map");

        let reopened =
            open_marker_file(&path).expect("mapped marker must reopen without truncation");
        assert!(reopened.metadata().unwrap().len() >= MARKER_BYTES);

        drop(reopened);
        drop(mapping);
        drop(original);
        std::fs::remove_file(path).expect("test marker must be removable after unmapping");
    }

    #[test]
    fn open_grows_short_file_to_marker_bytes() {
        let path = marker_path("short");
        std::fs::write(&path, [0_u8; 8]).expect("short marker fixture must write");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 8);

        let file = open_marker_file(&path).expect("short marker must open and grow");
        assert_eq!(file.metadata().unwrap().len(), MARKER_BYTES);
        drop(file);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), MARKER_BYTES);
        std::fs::remove_file(path).expect("short marker must be removable");
    }

    #[test]
    fn mark_and_clean_without_initialize_are_noops() {
        let _guard = CRASH_MARKER_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if MARKER.get().is_some() {
            // Another test already claimed the process-global marker.
            return;
        }
        mark(11, 2, STAGE_PROCESS);
        clean(11);
        assert!(MARKER.get().is_none());
    }

    #[test]
    fn initialize_mark_and_clean_write_cycle() {
        let _guard = CRASH_MARKER_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let path = marker_path("lifecycle");
        let initialized_here = MARKER.get().is_none();
        if initialized_here {
            // Cover the uninitialized no-op path before claiming the global marker.
            mark(1, 0, STAGE_PROCESS);
            clean(1);
            assert!(MARKER.get().is_none());
        }
        ensure_initialized(&path);

        let marker = MARKER.get().expect("marker must exist after initialize");
        mark(9, 3, STAGE_PROCESS);
        assert_eq!(marker.atomic(0).load(Ordering::Acquire), MAGIC);
        assert_eq!(marker.atomic(8).load(Ordering::Acquire), 9);
        assert_eq!(marker.atomic(16).load(Ordering::Acquire), 3);
        assert_eq!(marker.atomic(24).load(Ordering::Acquire), STAGE_PROCESS);
        assert_eq!(
            marker.atomic(32).load(Ordering::Acquire),
            MAGIC ^ 9 ^ 3 ^ STAGE_PROCESS ^ CHECKSUM_SALT
        );

        clean(9);
        assert_eq!(marker.atomic(8).load(Ordering::Acquire), 9);
        assert_eq!(marker.atomic(16).load(Ordering::Acquire), u64::MAX);
        assert_eq!(marker.atomic(24).load(Ordering::Acquire), STAGE_CLEAN);
        assert_eq!(
            marker.atomic(32).load(Ordering::Acquire),
            MAGIC ^ 9 ^ u64::MAX ^ STAGE_CLEAN ^ CHECKSUM_SALT
        );

        if initialized_here {
            // Shared mapping should also be visible via a fresh file read of the
            // path that backs this process-global marker.
            let bytes = std::fs::read(&path).expect("marker file must be readable");
            assert!(bytes.len() >= MARKER_BYTES as usize);
            let stage = u64::from_le_bytes(bytes[24..32].try_into().unwrap());
            assert_eq!(stage, STAGE_CLEAN);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn double_initialize_returns_already_exists() {
        let _guard = CRASH_MARKER_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let path = marker_path("double");
        ensure_initialized(&path);
        let error =
            initialize(&marker_path("double-again")).expect_err("second initialize must fail");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    }
}
