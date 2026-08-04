use std::{
    ffi::{CStr, c_char, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

#[cfg(unix)]
use clap_sys::ext::posix_fd_support::{
    CLAP_EXT_POSIX_FD_SUPPORT, CLAP_POSIX_FD_ERROR, CLAP_POSIX_FD_READ, CLAP_POSIX_FD_WRITE,
    clap_host_posix_fd_support, clap_posix_fd_flags,
};
use clap_sys::ext::{
    audio_ports::{CLAP_EXT_AUDIO_PORTS, clap_host_audio_ports},
    audio_ports_config::{CLAP_EXT_AUDIO_PORTS_CONFIG, clap_host_audio_ports_config},
    latency::{CLAP_EXT_LATENCY, clap_host_latency},
    log::{CLAP_EXT_LOG, clap_host_log, clap_log_severity},
    params::{CLAP_EXT_PARAMS, clap_host_params},
    tail::{CLAP_EXT_TAIL, clap_host_tail},
    thread_check::{CLAP_EXT_THREAD_CHECK, clap_host_thread_check},
    timer_support::{CLAP_EXT_TIMER_SUPPORT, clap_host_timer_support},
};
use clap_sys::{host::clap_host, version::CLAP_VERSION};

static HOST_NAME: &CStr = c"Heron";
static HOST_VENDOR: &CStr = c"Heron Studio";
static HOST_URL: &CStr = c"https://github.com/dsh0416/yadaw";
static HOST_VERSION: &CStr = c"0.4.1";

thread_local! {
    static AUDIO_THREAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

static THREAD_CHECK: clap_host_thread_check = clap_host_thread_check {
    is_main_thread: Some(is_main_thread),
    is_audio_thread: Some(is_audio_thread),
};

static LOG: clap_host_log = clap_host_log { log: Some(log) };
static PARAMS: clap_host_params = clap_host_params {
    rescan: Some(params_rescan),
    clear: Some(params_clear),
    request_flush: Some(params_request_flush),
};
static AUDIO_PORTS: clap_host_audio_ports = clap_host_audio_ports {
    is_rescan_flag_supported: Some(audio_ports_rescan_supported),
    rescan: Some(audio_ports_rescan),
};
static AUDIO_PORTS_CONFIG: clap_host_audio_ports_config = clap_host_audio_ports_config {
    rescan: Some(audio_ports_config_rescan),
};
static LATENCY: clap_host_latency = clap_host_latency {
    changed: Some(latency_changed),
};
static TAIL: clap_host_tail = clap_host_tail {
    changed: Some(tail_changed),
};
static TIMER_SUPPORT: clap_host_timer_support = clap_host_timer_support {
    register_timer: Some(register_timer),
    unregister_timer: Some(unregister_timer),
};
#[cfg(unix)]
static POSIX_FD_SUPPORT: clap_host_posix_fd_support = clap_host_posix_fd_support {
    register_fd: Some(register_fd),
    modify_fd: Some(modify_fd),
    unregister_fd: Some(unregister_fd),
};

struct HostTimer {
    id: u32,
    period: Duration,
    next: Instant,
}

#[cfg(unix)]
#[derive(Clone, Copy)]
pub(crate) struct ReadyPosixFd {
    pub(crate) fd: i32,
    pub(crate) flags: clap_posix_fd_flags,
}

#[cfg(unix)]
struct HostPosixFd {
    fd: i32,
    flags: clap_posix_fd_flags,
}

/// Lock-free core requests raised by CLAP callbacks.
#[derive(Default)]
pub struct ClapHostRequests {
    restart: AtomicBool,
    process: AtomicBool,
    callback: AtomicBool,
    parameter_rescan: AtomicU32,
    audio_port_rescan: AtomicU32,
    latency_changed: AtomicBool,
    tail_changed: AtomicBool,
}

/// One coalesced snapshot consumed by the control plane.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostRequestSnapshot {
    pub restart: bool,
    pub process: bool,
    pub callback: bool,
    pub parameter_rescan: u32,
    pub audio_port_rescan: u32,
    pub latency_changed: bool,
    pub tail_changed: bool,
}

impl ClapHostRequests {
    #[must_use]
    pub fn take(&self) -> HostRequestSnapshot {
        HostRequestSnapshot {
            restart: self.restart.swap(false, Ordering::AcqRel),
            process: self.process.load(Ordering::Acquire),
            callback: self.callback.swap(false, Ordering::AcqRel),
            parameter_rescan: self.parameter_rescan.swap(0, Ordering::AcqRel),
            audio_port_rescan: self.audio_port_rescan.swap(0, Ordering::AcqRel),
            latency_changed: self.latency_changed.swap(false, Ordering::AcqRel),
            tail_changed: self.tail_changed.swap(false, Ordering::AcqRel),
        }
    }

    #[must_use]
    pub fn process_requested(&self) -> bool {
        self.process.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn take_process_request(&self) -> bool {
        self.process.swap(false, Ordering::AcqRel)
    }
}

pub(crate) struct HostContext {
    raw: clap_host,
    requests: Arc<ClapHostRequests>,
    main_thread: std::thread::ThreadId,
    next_timer_id: AtomicU32,
    timers: Mutex<Vec<HostTimer>>,
    #[cfg(unix)]
    posix_fds: Mutex<Vec<HostPosixFd>>,
}

impl HostContext {
    pub(crate) fn new(requests: Arc<ClapHostRequests>) -> Pin<Box<Self>> {
        let mut context = Box::pin(Self {
            raw: clap_host {
                clap_version: CLAP_VERSION,
                host_data: std::ptr::null_mut(),
                name: HOST_NAME.as_ptr(),
                vendor: HOST_VENDOR.as_ptr(),
                url: HOST_URL.as_ptr(),
                version: HOST_VERSION.as_ptr(),
                get_extension: Some(get_extension),
                request_restart: Some(request_restart),
                request_process: Some(request_process),
                request_callback: Some(request_callback),
            },
            requests,
            main_thread: std::thread::current().id(),
            next_timer_id: AtomicU32::new(1),
            timers: Mutex::new(Vec::new()),
            #[cfg(unix)]
            posix_fds: Mutex::new(Vec::new()),
        });
        let pointer = (&*context as *const Self).cast_mut().cast::<c_void>();
        // SAFETY: `context` is pinned before its self pointer is installed and
        // remains pinned for every callback made through `raw`.
        unsafe { Pin::as_mut(&mut context).get_unchecked_mut() }
            .raw
            .host_data = pointer;
        context
    }

    pub(crate) fn raw(&self) -> *const clap_host {
        &self.raw
    }

    pub(crate) fn take_due_timers(&self, now: Instant) -> Vec<u32> {
        let Ok(mut timers) = self.timers.lock() else {
            return Vec::new();
        };
        let mut due = Vec::new();
        for timer in &mut *timers {
            if timer.next <= now {
                due.push(timer.id);
                timer.next = now + timer.period;
            }
        }
        due
    }

    #[cfg(unix)]
    pub(crate) fn ready_posix_fds(&self) -> Vec<ReadyPosixFd> {
        let Ok(fds) = self.posix_fds.lock() else {
            return Vec::new();
        };
        let mut poll_fds = fds
            .iter()
            .map(|entry| libc::pollfd {
                fd: entry.fd,
                events: posix_to_poll(entry.flags),
                revents: 0,
            })
            .collect::<Vec<_>>();
        if poll_fds.is_empty() {
            return Vec::new();
        }
        // SAFETY: `poll_fds` is a live contiguous array and timeout zero never blocks.
        if unsafe { libc::poll(poll_fds.as_mut_ptr(), poll_fds.len() as _, 0) } <= 0 {
            return Vec::new();
        }
        poll_fds
            .into_iter()
            .filter_map(|fd| {
                let flags = poll_to_posix(fd.revents);
                (flags != 0).then_some(ReadyPosixFd { fd: fd.fd, flags })
            })
            .collect()
    }
}

pub(crate) struct AudioThreadScope;

impl AudioThreadScope {
    pub(crate) fn enter() -> Self {
        AUDIO_THREAD.with(|value| value.set(true));
        Self
    }
}

impl Drop for AudioThreadScope {
    fn drop(&mut self) {
        AUDIO_THREAD.with(|value| value.set(false));
    }
}

unsafe fn requests(host: *const clap_host) -> Option<&'static ClapHostRequests> {
    // SAFETY: Forward the same pinned host pointer validation to `context`.
    unsafe { context(host) }.map(|context| context.requests.as_ref())
}

unsafe fn context(host: *const clap_host) -> Option<&'static HostContext> {
    if host.is_null() {
        return None;
    }
    // SAFETY: All host pointers passed to plug-ins originate from a pinned
    // `HostContext` and remain valid until after the plug-in is destroyed.
    unsafe { (*host).host_data.cast::<HostContext>().as_ref() }
}

unsafe extern "C" fn get_extension(
    host: *const clap_host,
    extension_id: *const c_char,
) -> *const c_void {
    catch_unwind(AssertUnwindSafe(|| {
        if host.is_null() || extension_id.is_null() {
            return std::ptr::null();
        }
        // SAFETY: CLAP extension IDs are NUL-terminated for this synchronous call.
        let identifier = unsafe { CStr::from_ptr(extension_id) };
        #[cfg(unix)]
        if identifier == CLAP_EXT_POSIX_FD_SUPPORT {
            return (&POSIX_FD_SUPPORT as *const clap_host_posix_fd_support).cast();
        }
        if identifier == CLAP_EXT_THREAD_CHECK {
            (&THREAD_CHECK as *const clap_host_thread_check).cast()
        } else if identifier == CLAP_EXT_LOG {
            (&LOG as *const clap_host_log).cast()
        } else if identifier == CLAP_EXT_PARAMS {
            (&PARAMS as *const clap_host_params).cast()
        } else if identifier == CLAP_EXT_AUDIO_PORTS {
            (&AUDIO_PORTS as *const clap_host_audio_ports).cast()
        } else if identifier == CLAP_EXT_AUDIO_PORTS_CONFIG {
            (&AUDIO_PORTS_CONFIG as *const clap_host_audio_ports_config).cast()
        } else if identifier == CLAP_EXT_LATENCY {
            (&LATENCY as *const clap_host_latency).cast()
        } else if identifier == CLAP_EXT_TAIL {
            (&TAIL as *const clap_host_tail).cast()
        } else if identifier == CLAP_EXT_TIMER_SUPPORT {
            (&TIMER_SUPPORT as *const clap_host_timer_support).cast()
        } else {
            std::ptr::null()
        }
    }))
    .unwrap_or(std::ptr::null())
}

unsafe extern "C" fn is_main_thread(host: *const clap_host) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        if host.is_null() {
            return false;
        }
        // SAFETY: Host data points to the pinned `HostContext`.
        unsafe { (*host).host_data.cast::<HostContext>().as_ref() }
            .is_some_and(|context| context.main_thread == std::thread::current().id())
    }))
    .unwrap_or(false)
}

unsafe extern "C" fn is_audio_thread(_host: *const clap_host) -> bool {
    catch_unwind(AssertUnwindSafe(|| AUDIO_THREAD.with(std::cell::Cell::get))).unwrap_or(false)
}

unsafe extern "C" fn log(
    _host: *const clap_host,
    _severity: clap_log_severity,
    _message: *const c_char,
) {
    // Intentionally bounded and allocation-free. A later control-plane poll can
    // expose counters without ever formatting plug-in text on the audio thread.
}

unsafe extern "C" fn request_restart(host: *const clap_host) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: The callback receives the host pointer installed above.
        if let Some(requests) = unsafe { requests(host) } {
            requests.restart.store(true, Ordering::Release);
        }
    }));
}

unsafe extern "C" fn request_process(host: *const clap_host) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: The callback receives the host pointer installed above.
        if let Some(requests) = unsafe { requests(host) } {
            requests.process.store(true, Ordering::Release);
        }
    }));
}

unsafe extern "C" fn request_callback(host: *const clap_host) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: The callback receives the host pointer installed above.
        if let Some(requests) = unsafe { requests(host) } {
            requests.callback.store(true, Ordering::Release);
        }
    }));
}

unsafe extern "C" fn params_rescan(host: *const clap_host, flags: u32) {
    update_flags(host, flags, |requests| &requests.parameter_rescan);
}

unsafe extern "C" fn params_clear(_host: *const clap_host, _param_id: u32, _flags: u32) {}

unsafe extern "C" fn params_request_flush(host: *const clap_host) {
    // A flush requires another process turn when processing is active.
    // SAFETY: CLAP supplies the same live host pointer received by this callback.
    unsafe { request_process(host) };
}

unsafe extern "C" fn audio_ports_rescan_supported(_host: *const clap_host, _flag: u32) -> bool {
    true
}

unsafe extern "C" fn audio_ports_rescan(host: *const clap_host, flags: u32) {
    update_flags(host, flags, |requests| &requests.audio_port_rescan);
}

unsafe extern "C" fn audio_ports_config_rescan(host: *const clap_host) {
    update_flags(host, u32::MAX, |requests| &requests.audio_port_rescan);
}

unsafe extern "C" fn latency_changed(host: *const clap_host) {
    update_bool(host, |requests| &requests.latency_changed);
}

unsafe extern "C" fn tail_changed(host: *const clap_host) {
    update_bool(host, |requests| &requests.tail_changed);
}

unsafe extern "C" fn register_timer(
    host: *const clap_host,
    period_ms: u32,
    timer_id: *mut u32,
) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        if period_ms == 0 || timer_id.is_null() {
            return false;
        }
        // SAFETY: CLAP passes the pinned host pointer and a writable ID output.
        let Some(context) = (unsafe { context(host) }) else {
            return false;
        };
        let id = context.next_timer_id.fetch_add(1, Ordering::AcqRel);
        if id == u32::MAX {
            return false;
        }
        let period = Duration::from_millis(u64::from(period_ms));
        let Ok(mut timers) = context.timers.lock() else {
            return false;
        };
        timers.push(HostTimer {
            id,
            period,
            next: Instant::now() + period,
        });
        // SAFETY: Null was rejected and CLAP owns this synchronous output.
        unsafe { *timer_id = id };
        true
    }))
    .unwrap_or(false)
}

unsafe extern "C" fn unregister_timer(host: *const clap_host, timer_id: u32) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: CLAP passes the pinned host pointer received during init.
        let Some(context) = (unsafe { context(host) }) else {
            return false;
        };
        let Ok(mut timers) = context.timers.lock() else {
            return false;
        };
        let Some(index) = timers.iter().position(|timer| timer.id == timer_id) else {
            return false;
        };
        timers.swap_remove(index);
        true
    }))
    .unwrap_or(false)
}

#[cfg(unix)]
unsafe extern "C" fn register_fd(
    host: *const clap_host,
    fd: i32,
    flags: clap_posix_fd_flags,
) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        if fd < 0 || flags & !(CLAP_POSIX_FD_READ | CLAP_POSIX_FD_WRITE | CLAP_POSIX_FD_ERROR) != 0
        {
            return false;
        }
        // SAFETY: CLAP passes the pinned host pointer received during init.
        let Some(context) = (unsafe { context(host) }) else {
            return false;
        };
        let Ok(mut fds) = context.posix_fds.lock() else {
            return false;
        };
        if fds.iter().any(|entry| entry.fd == fd) {
            return false;
        }
        fds.push(HostPosixFd { fd, flags });
        true
    }))
    .unwrap_or(false)
}

#[cfg(unix)]
unsafe extern "C" fn modify_fd(
    host: *const clap_host,
    fd: i32,
    flags: clap_posix_fd_flags,
) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: CLAP passes the pinned host pointer received during init.
        let Some(context) = (unsafe { context(host) }) else {
            return false;
        };
        let Ok(mut fds) = context.posix_fds.lock() else {
            return false;
        };
        let Some(entry) = fds.iter_mut().find(|entry| entry.fd == fd) else {
            return false;
        };
        entry.flags = flags;
        true
    }))
    .unwrap_or(false)
}

#[cfg(unix)]
unsafe extern "C" fn unregister_fd(host: *const clap_host, fd: i32) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: CLAP passes the pinned host pointer received during init.
        let Some(context) = (unsafe { context(host) }) else {
            return false;
        };
        let Ok(mut fds) = context.posix_fds.lock() else {
            return false;
        };
        let Some(index) = fds.iter().position(|entry| entry.fd == fd) else {
            return false;
        };
        fds.swap_remove(index);
        true
    }))
    .unwrap_or(false)
}

#[cfg(unix)]
fn posix_to_poll(flags: clap_posix_fd_flags) -> i16 {
    let mut result = 0;
    if flags & CLAP_POSIX_FD_READ != 0 {
        result |= libc::POLLIN;
    }
    if flags & CLAP_POSIX_FD_WRITE != 0 {
        result |= libc::POLLOUT;
    }
    result
}

#[cfg(unix)]
fn poll_to_posix(flags: i16) -> clap_posix_fd_flags {
    let mut result = 0;
    if flags & libc::POLLIN != 0 {
        result |= CLAP_POSIX_FD_READ;
    }
    if flags & libc::POLLOUT != 0 {
        result |= CLAP_POSIX_FD_WRITE;
    }
    if flags & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
        result |= CLAP_POSIX_FD_ERROR;
    }
    result
}

fn update_flags(
    host: *const clap_host,
    flags: u32,
    select: impl FnOnce(&ClapHostRequests) -> &AtomicU32,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: CLAP invokes this callback with the pinned host pointer.
        if let Some(requests) = unsafe { requests(host) } {
            select(requests).fetch_or(flags, Ordering::AcqRel);
        }
    }));
}

fn update_bool(host: *const clap_host, select: impl FnOnce(&ClapHostRequests) -> &AtomicBool) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: CLAP invokes this callback with the pinned host pointer.
        if let Some(requests) = unsafe { requests(host) } {
            select(requests).store(true, Ordering::Release);
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_requests_are_coalesced_and_consumed_without_locks() {
        let requests = Arc::new(ClapHostRequests::default());
        let host = HostContext::new(Arc::clone(&requests));
        // SAFETY: The pinned test host remains live for all callbacks.
        unsafe {
            request_restart(host.raw());
            request_restart(host.raw());
            request_process(host.raw());
            request_callback(host.raw());
        }
        let snapshot = requests.take();
        assert!(snapshot.restart);
        assert!(snapshot.process);
        assert!(snapshot.callback);
        assert!(!requests.take().restart);
        assert!(requests.take_process_request());
        assert!(!requests.take_process_request());
    }

    #[test]
    fn extension_callbacks_merge_rescan_and_timing_flags() {
        let requests = Arc::new(ClapHostRequests::default());
        let host = HostContext::new(Arc::clone(&requests));
        // SAFETY: The pinned test host remains live for all callbacks.
        unsafe {
            params_rescan(host.raw(), 1);
            params_rescan(host.raw(), 4);
            audio_ports_rescan(host.raw(), 8);
            latency_changed(host.raw());
            tail_changed(host.raw());
        }
        let snapshot = requests.take();
        assert_eq!(snapshot.parameter_rescan, 5);
        assert_eq!(snapshot.audio_port_rescan, 8);
        assert!(snapshot.latency_changed);
        assert!(snapshot.tail_changed);
    }

    #[test]
    fn timer_registration_dispatches_and_unregisters_on_the_control_thread() {
        let requests = Arc::new(ClapHostRequests::default());
        let host = HostContext::new(requests);
        let mut timer_id = 0;
        // SAFETY: The pinned test host and writable output remain live.
        assert!(unsafe { register_timer(host.raw(), 1, &mut timer_id) });
        assert_ne!(timer_id, 0);
        {
            let mut timers = host.timers.lock().unwrap();
            timers[0].next = Instant::now();
        }
        assert_eq!(host.take_due_timers(Instant::now()), vec![timer_id]);
        // SAFETY: The ID was registered against this live host.
        assert!(unsafe { unregister_timer(host.raw(), timer_id) });
        // SAFETY: The pinned host remains live; this verifies unknown-ID rejection.
        assert!(!unsafe { unregister_timer(host.raw(), timer_id) });
    }
}
