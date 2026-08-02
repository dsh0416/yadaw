use std::{
    ffi::c_void,
    os::raw::c_char,
    sync::atomic::{AtomicU32, Ordering},
    time::Instant,
};

use yadaw_vst3_host_sys::{
    Steinberg::{FUnknown, IPlugFrame, IPlugView, ViewRect, tresult, uint32},
    abi::{FUnknownVTable, PlugFrameVTable},
    iid,
};

#[cfg(any(target_os = "linux", test))]
use std::cell::RefCell;

#[cfg(any(target_os = "linux", test))]
use linux::{RunLoopInterface, RunLoopState};

#[repr(C)]
pub struct PlugFrame {
    vtable: *const PlugFrameVTable,
    references: AtomicU32,
    resize: Box<dyn FnMut(*mut IPlugView, ViewRect) -> bool>,
    #[cfg(any(target_os = "linux", test))]
    run_loop: RunLoopInterface,
    #[cfg(any(target_os = "linux", test))]
    run_loop_state: RefCell<RunLoopState>,
}

impl PlugFrame {
    pub fn new(resize: impl FnMut(*mut IPlugView, ViewRect) -> bool + 'static) -> Box<Self> {
        let frame = Box::new(Self {
            vtable: &PLUG_FRAME_VTABLE,
            references: AtomicU32::new(1),
            resize: Box::new(resize),
            #[cfg(any(target_os = "linux", test))]
            run_loop: RunLoopInterface::new(),
            #[cfg(any(target_os = "linux", test))]
            run_loop_state: RefCell::new(RunLoopState::new()),
        });
        #[cfg(any(target_os = "linux", test))]
        let mut frame = frame;
        #[cfg(any(target_os = "linux", test))]
        {
            let owner = std::ptr::from_mut(frame.as_mut());
            frame.run_loop.set_owner(owner);
        }
        frame
    }

    #[must_use]
    pub fn as_interface(&mut self) -> *mut IPlugFrame {
        std::ptr::from_mut(self).cast()
    }

    #[cfg(all(not(target_os = "linux"), not(test)))]
    pub fn dispatch_run_loop(&mut self, _now: Instant) -> Option<Instant> {
        None
    }

    #[cfg(any(target_os = "linux", test))]
    pub fn dispatch_run_loop(&mut self, now: Instant) -> Option<Instant> {
        linux::dispatch(self, now)
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
    #[cfg(any(target_os = "linux", test))]
    if requested == iid::IRUN_LOOP {
        let frame = unsafe {
            // SAFETY: this is the leading interface pointer of the live host-owned PlugFrame.
            &mut *this.cast::<PlugFrame>()
        };
        unsafe {
            // SAFETY: the run-loop interface is a stable field of the boxed PlugFrame and output
            // is writable as validated above.
            output.write(std::ptr::from_mut(&mut frame.run_loop).cast());
            add_ref(this);
        }
        return 0;
    }
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

#[cfg(any(target_os = "linux", test))]
mod linux {
    use std::{
        ptr::NonNull,
        time::{Duration, Instant},
    };

    use libc::{POLLERR, POLLHUP, POLLIN, poll, pollfd};
    use yadaw_vst3_host_sys::{
        Steinberg::{
            FUnknown,
            Linux::{IEventHandler, IRunLoop, ITimerHandler},
            tresult, uint32,
        },
        abi::{EventHandlerVTable, FUnknownVTable, RunLoopVTable, TimerHandlerVTable},
    };

    use super::{PlugFrame, add_ref, query_interface, release};
    use crate::ComPtr;

    const INVALID_ARGUMENT: tresult = -2147024809;
    const RESULT_FALSE: tresult = 1;

    #[repr(C)]
    pub(super) struct RunLoopInterface {
        vtable: *const RunLoopVTable,
        owner: Option<NonNull<PlugFrame>>,
    }

    pub(super) struct RunLoopState {
        events: Vec<EventRegistration>,
        timers: Vec<TimerRegistration>,
        pollfds: Vec<pollfd>,
    }

    struct EventRegistration {
        handler: ComPtr<IEventHandler>,
        fd: i32,
    }

    struct TimerRegistration {
        handler: ComPtr<ITimerHandler>,
        interval: Duration,
        next_fire: Instant,
    }

    impl RunLoopInterface {
        pub(super) const fn new() -> Self {
            Self {
                vtable: &RUN_LOOP_VTABLE,
                owner: None,
            }
        }

        pub(super) fn set_owner(&mut self, owner: *mut PlugFrame) {
            self.owner = NonNull::new(owner);
        }
    }

    impl RunLoopState {
        pub(super) const fn new() -> Self {
            Self {
                events: Vec::new(),
                timers: Vec::new(),
                pollfds: Vec::new(),
            }
        }
    }

    pub(super) fn dispatch(frame: &PlugFrame, now: Instant) -> Option<Instant> {
        let ready_events = collect_ready_events(frame);
        for (handler, fd) in ready_events {
            unsafe {
                // SAFETY: the retained handler is live for the call and its vtable matches the
                // IEventHandler interface supplied during registration.
                ((*event_handler_table(&handler)).on_fd_is_set)(handler.as_ptr(), fd);
            }
        }

        let due_timers = collect_due_timers(frame, now);
        for handler in due_timers {
            unsafe {
                // SAFETY: the retained handler is live for the call and its vtable matches the
                // ITimerHandler interface supplied during registration.
                ((*timer_handler_table(&handler)).on_timer)(handler.as_ptr());
            }
        }

        frame
            .run_loop_state
            .try_borrow()
            .ok()
            .and_then(|state| state.timers.iter().map(|timer| timer.next_fire).min())
    }

    fn collect_ready_events(frame: &PlugFrame) -> Vec<(ComPtr<IEventHandler>, i32)> {
        let Ok(mut state) = frame.run_loop_state.try_borrow_mut() else {
            return Vec::new();
        };
        let descriptors = state
            .events
            .iter()
            .map(|event| pollfd {
                fd: event.fd,
                events: POLLIN,
                revents: 0,
            })
            .collect::<Vec<_>>();
        state.pollfds = descriptors;
        let descriptor_count = state.pollfds.len();
        if descriptor_count == 0 {
            return Vec::new();
        }
        let result = unsafe {
            // SAFETY: pollfds is live writable storage for descriptor_count entries and timeout
            // zero makes this a non-blocking UI-thread readiness check.
            poll(
                state.pollfds.as_mut_ptr(),
                descriptor_count as libc::nfds_t,
                0,
            )
        };
        if result <= 0 {
            return Vec::new();
        }
        state
            .events
            .iter()
            .zip(&state.pollfds)
            .filter(|(_, descriptor)| descriptor.revents & (POLLIN | POLLERR | POLLHUP) != 0)
            .map(|(event, _)| (event.handler.clone(), event.fd))
            .collect()
    }

    fn collect_due_timers(frame: &PlugFrame, now: Instant) -> Vec<ComPtr<ITimerHandler>> {
        let Ok(mut state) = frame.run_loop_state.try_borrow_mut() else {
            return Vec::new();
        };
        let mut due = Vec::new();
        for timer in &mut state.timers {
            if now < timer.next_fire {
                continue;
            }
            due.push(timer.handler.clone());
            timer.next_fire = advance_timer(now, timer.interval);
        }
        due
    }

    fn advance_timer(now: Instant, interval: Duration) -> Instant {
        now.checked_add(interval)
            .unwrap_or_else(|| now + Duration::from_secs(1))
    }

    unsafe extern "system" fn run_loop_query_interface(
        this: *mut FUnknown,
        requested: *const std::os::raw::c_char,
        output: *mut *mut std::ffi::c_void,
    ) -> tresult {
        let Some(owner) = (unsafe {
            // SAFETY: this is the leading FUnknown interface of RunLoopInterface.
            owner_from_run_loop(this.cast::<IRunLoop>())
        }) else {
            return RESULT_FALSE;
        };
        unsafe {
            // SAFETY: owner points to the live containing PlugFrame and query_interface validates
            // the remaining pointers before writing output.
            query_interface(owner.cast::<FUnknown>(), requested, output)
        }
    }

    unsafe extern "system" fn run_loop_add_ref(this: *mut FUnknown) -> uint32 {
        let Some(owner) = (unsafe {
            // SAFETY: this is the leading FUnknown interface of RunLoopInterface.
            owner_from_run_loop(this.cast::<IRunLoop>())
        }) else {
            return 0;
        };
        unsafe {
            // SAFETY: owner points to the live containing PlugFrame.
            add_ref(owner.cast::<FUnknown>())
        }
    }

    unsafe extern "system" fn run_loop_release(this: *mut FUnknown) -> uint32 {
        let Some(owner) = (unsafe {
            // SAFETY: this is the leading FUnknown interface of RunLoopInterface.
            owner_from_run_loop(this.cast::<IRunLoop>())
        }) else {
            return 0;
        };
        unsafe {
            // SAFETY: owner points to the live containing PlugFrame.
            release(owner.cast::<FUnknown>())
        }
    }

    unsafe extern "system" fn register_event_handler(
        this: *mut IRunLoop,
        handler: *mut IEventHandler,
        fd: i32,
    ) -> tresult {
        if handler.is_null() || fd < 0 {
            return INVALID_ARGUMENT;
        }
        let Some(owner) = (unsafe {
            // SAFETY: this is the live run-loop interface supplied by PlugFrame.
            owner_from_run_loop(this)
        }) else {
            return RESULT_FALSE;
        };
        let frame = unsafe {
            // SAFETY: owner remains live while the plug-in retains this interface.
            &*owner
        };
        let Ok(mut state) = frame.run_loop_state.try_borrow_mut() else {
            return RESULT_FALSE;
        };
        if state.events.iter().any(|event| event.fd == fd) {
            return INVALID_ARGUMENT;
        }
        let Ok(handler) = (unsafe {
            // SAFETY: the plug-in passed a non-null live borrowed handler for registration.
            ComPtr::retain_raw(handler, "IRunLoop::registerEventHandler")
        }) else {
            return INVALID_ARGUMENT;
        };
        state.events.push(EventRegistration { handler, fd });
        0
    }

    unsafe extern "system" fn unregister_event_handler(
        this: *mut IRunLoop,
        handler: *mut IEventHandler,
    ) -> tresult {
        if handler.is_null() {
            return INVALID_ARGUMENT;
        }
        let Some(owner) = (unsafe {
            // SAFETY: this is the live run-loop interface supplied by PlugFrame.
            owner_from_run_loop(this)
        }) else {
            return RESULT_FALSE;
        };
        let frame = unsafe {
            // SAFETY: owner remains live while the plug-in retains this interface.
            &*owner
        };
        let Ok(mut state) = frame.run_loop_state.try_borrow_mut() else {
            return RESULT_FALSE;
        };
        let Some(index) = state
            .events
            .iter()
            .position(|event| event.handler.as_ptr() == handler)
        else {
            return RESULT_FALSE;
        };
        state.events.swap_remove(index);
        0
    }

    unsafe extern "system" fn register_timer(
        this: *mut IRunLoop,
        handler: *mut ITimerHandler,
        milliseconds: u64,
    ) -> tresult {
        if handler.is_null() || milliseconds == 0 {
            return INVALID_ARGUMENT;
        }
        let Some(owner) = (unsafe {
            // SAFETY: this is the live run-loop interface supplied by PlugFrame.
            owner_from_run_loop(this)
        }) else {
            return RESULT_FALSE;
        };
        let interval = Duration::from_millis(milliseconds);
        let Some(next_fire) = Instant::now().checked_add(interval) else {
            return INVALID_ARGUMENT;
        };
        let Ok(handler) = (unsafe {
            // SAFETY: the plug-in passed a non-null live borrowed handler for registration.
            ComPtr::retain_raw(handler, "IRunLoop::registerTimer")
        }) else {
            return INVALID_ARGUMENT;
        };
        let frame = unsafe {
            // SAFETY: owner remains live while the plug-in retains this interface.
            &*owner
        };
        let Ok(mut state) = frame.run_loop_state.try_borrow_mut() else {
            return RESULT_FALSE;
        };
        state.timers.push(TimerRegistration {
            handler,
            interval,
            next_fire,
        });
        0
    }

    unsafe extern "system" fn unregister_timer(
        this: *mut IRunLoop,
        handler: *mut ITimerHandler,
    ) -> tresult {
        if handler.is_null() {
            return INVALID_ARGUMENT;
        }
        let Some(owner) = (unsafe {
            // SAFETY: this is the live run-loop interface supplied by PlugFrame.
            owner_from_run_loop(this)
        }) else {
            return RESULT_FALSE;
        };
        let frame = unsafe {
            // SAFETY: owner remains live while the plug-in retains this interface.
            &*owner
        };
        let Ok(mut state) = frame.run_loop_state.try_borrow_mut() else {
            return RESULT_FALSE;
        };
        let Some(index) = state
            .timers
            .iter()
            .position(|timer| timer.handler.as_ptr() == handler)
        else {
            return RESULT_FALSE;
        };
        state.timers.swap_remove(index);
        0
    }

    unsafe fn owner_from_run_loop(this: *mut IRunLoop) -> Option<*mut PlugFrame> {
        if this.is_null() {
            return None;
        }
        unsafe {
            // SAFETY: this points to the leading interface field of a live RunLoopInterface.
            (*this.cast::<RunLoopInterface>())
                .owner
                .map(NonNull::as_ptr)
        }
    }

    fn event_handler_table(handler: &ComPtr<IEventHandler>) -> *const EventHandlerVTable {
        unsafe {
            // SAFETY: ComPtr guarantees the object's leading vtable pointer.
            *handler.as_ptr().cast::<*const EventHandlerVTable>()
        }
    }

    fn timer_handler_table(handler: &ComPtr<ITimerHandler>) -> *const TimerHandlerVTable {
        unsafe {
            // SAFETY: ComPtr guarantees the object's leading vtable pointer.
            *handler.as_ptr().cast::<*const TimerHandlerVTable>()
        }
    }

    static RUN_LOOP_VTABLE: RunLoopVTable = RunLoopVTable {
        base: FUnknownVTable {
            query_interface: run_loop_query_interface,
            add_ref: run_loop_add_ref,
            release: run_loop_release,
        },
        register_event_handler,
        unregister_event_handler,
        register_timer,
        unregister_timer,
    };
}

#[cfg(test)]
mod tests {
    use std::{
        cell::Cell,
        ffi::c_void,
        os::raw::c_char,
        rc::Rc,
        sync::atomic::{AtomicU32, Ordering},
        time::{Duration, Instant},
    };

    use yadaw_vst3_host_sys::{
        Steinberg::{
            FUnknown,
            Linux::{IEventHandler, IRunLoop, ITimerHandler},
            tresult, uint32,
        },
        abi::{EventHandlerVTable, FUnknownVTable, RunLoopVTable, TimerHandlerVTable},
    };

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

    #[test]
    fn run_loop_timer_is_retained_dispatched_and_unregistered() {
        let mut frame = PlugFrame::new(|_, _| true);
        let mut run_loop = std::ptr::null_mut::<c_void>();
        let query_result = unsafe {
            // SAFETY: frame is live and run_loop is writable interface output storage.
            query_interface(
                frame.as_interface().cast::<FUnknown>(),
                iid::IRUN_LOOP.as_ptr(),
                std::ptr::addr_of_mut!(run_loop),
            )
        };
        assert_eq!(query_result, 0);
        let run_loop = run_loop.cast::<IRunLoop>();
        let run_loop_table = unsafe {
            // SAFETY: successful queryInterface returned the IRunLoop sub-interface.
            *run_loop.cast::<*const RunLoopVTable>()
        };

        let mut handler = Box::new(MockTimerHandler::new());
        assert_eq!(handler.references.load(Ordering::Relaxed), 1);
        let register_result = unsafe {
            // SAFETY: run loop and handler remain live until explicit unregister below.
            ((*run_loop_table).register_timer)(run_loop, handler.as_interface(), 10)
        };
        assert_eq!(register_result, 0);
        assert_eq!(handler.references.load(Ordering::Relaxed), 2);

        frame.dispatch_run_loop(Instant::now() + Duration::from_millis(20));
        assert_eq!(handler.calls.load(Ordering::Relaxed), 1);

        let unregister_result = unsafe {
            // SAFETY: run loop and registered handler remain live for this call.
            ((*run_loop_table).unregister_timer)(run_loop, handler.as_interface())
        };
        assert_eq!(unregister_result, 0);
        assert_eq!(handler.references.load(Ordering::Relaxed), 1);
        frame.dispatch_run_loop(Instant::now() + Duration::from_secs(1));
        assert_eq!(handler.calls.load(Ordering::Relaxed), 1);

        unsafe {
            // SAFETY: balances the owned IRunLoop reference returned by queryInterface.
            ((*run_loop_table).base.release)(run_loop.cast::<FUnknown>());
        }
    }

    #[test]
    fn run_loop_event_is_retained_dispatched_and_unregistered() {
        let mut frame = PlugFrame::new(|_, _| true);
        let mut run_loop = std::ptr::null_mut::<c_void>();
        let query_result = unsafe {
            // SAFETY: frame is live and run_loop is writable interface output storage.
            query_interface(
                frame.as_interface().cast::<FUnknown>(),
                iid::IRUN_LOOP.as_ptr(),
                std::ptr::addr_of_mut!(run_loop),
            )
        };
        assert_eq!(query_result, 0);
        let run_loop = run_loop.cast::<IRunLoop>();
        let run_loop_table = unsafe {
            // SAFETY: successful queryInterface returned the IRunLoop sub-interface.
            *run_loop.cast::<*const RunLoopVTable>()
        };

        let mut pipe_fds = [-1; 2];
        let pipe_result = unsafe {
            // SAFETY: pipe_fds provides writable storage for the two created descriptors.
            libc::pipe(pipe_fds.as_mut_ptr())
        };
        assert_eq!(pipe_result, 0);

        let mut handler = Box::new(MockEventHandler::new());
        assert_eq!(handler.references.load(Ordering::Relaxed), 1);
        let register_result = unsafe {
            // SAFETY: run loop, handler, and read descriptor remain live until unregister below.
            ((*run_loop_table).register_event_handler)(
                run_loop,
                handler.as_interface(),
                pipe_fds[0],
            )
        };
        assert_eq!(register_result, 0);
        assert_eq!(handler.references.load(Ordering::Relaxed), 2);

        let byte = [1_u8];
        let written = unsafe {
            // SAFETY: the write descriptor is live and byte provides one readable byte.
            libc::write(pipe_fds[1], byte.as_ptr().cast(), byte.len())
        };
        assert_eq!(written, 1);
        frame.dispatch_run_loop(Instant::now());
        assert_eq!(handler.calls.load(Ordering::Relaxed), 1);

        let unregister_result = unsafe {
            // SAFETY: run loop and registered handler remain live for this call.
            ((*run_loop_table).unregister_event_handler)(run_loop, handler.as_interface())
        };
        assert_eq!(unregister_result, 0);
        assert_eq!(handler.references.load(Ordering::Relaxed), 1);
        frame.dispatch_run_loop(Instant::now());
        assert_eq!(handler.calls.load(Ordering::Relaxed), 1);

        unsafe {
            // SAFETY: balances the owned IRunLoop reference and closes both descriptors once.
            ((*run_loop_table).base.release)(run_loop.cast::<FUnknown>());
            libc::close(pipe_fds[0]);
            libc::close(pipe_fds[1]);
        }
    }

    #[repr(C)]
    struct MockEventHandler {
        vtable: *const EventHandlerVTable,
        references: AtomicU32,
        calls: AtomicU32,
    }

    impl MockEventHandler {
        const fn new() -> Self {
            Self {
                vtable: &MOCK_EVENT_VTABLE,
                references: AtomicU32::new(1),
                calls: AtomicU32::new(0),
            }
        }

        fn as_interface(&mut self) -> *mut IEventHandler {
            std::ptr::from_mut(self).cast()
        }
    }

    unsafe extern "system" fn mock_event_query_interface(
        this: *mut FUnknown,
        requested: *const c_char,
        output: *mut *mut c_void,
    ) -> tresult {
        if requested.is_null() || output.is_null() {
            return -2147024809;
        }
        let requested = unsafe {
            // SAFETY: VST3 queryInterface supplies one 16-byte TUID.
            std::slice::from_raw_parts(requested, 16)
        };
        if requested == iid::FUNKNOWN || requested == iid::IEVENT_HANDLER {
            unsafe {
                // SAFETY: output is writable and MockEventHandler starts with this interface.
                output.write(this.cast());
                mock_event_add_ref(this);
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

    unsafe extern "system" fn mock_event_add_ref(this: *mut FUnknown) -> uint32 {
        let handler = this.cast::<MockEventHandler>();
        unsafe {
            // SAFETY: this is the leading interface of the live mock handler.
            (*handler).references.fetch_add(1, Ordering::Relaxed) + 1
        }
    }

    unsafe extern "system" fn mock_event_release(this: *mut FUnknown) -> uint32 {
        let handler = this.cast::<MockEventHandler>();
        unsafe {
            // SAFETY: each owned mock reference is released at most once.
            (*handler).references.fetch_sub(1, Ordering::Relaxed) - 1
        }
    }

    unsafe extern "system" fn mock_on_fd_is_set(this: *mut IEventHandler, _fd: i32) {
        let handler = this.cast::<MockEventHandler>();
        unsafe {
            // SAFETY: this is the leading interface of the retained live mock handler.
            (*handler).calls.fetch_add(1, Ordering::Relaxed);
        }
    }

    static MOCK_EVENT_VTABLE: EventHandlerVTable = EventHandlerVTable {
        base: FUnknownVTable {
            query_interface: mock_event_query_interface,
            add_ref: mock_event_add_ref,
            release: mock_event_release,
        },
        on_fd_is_set: mock_on_fd_is_set,
    };

    #[repr(C)]
    struct MockTimerHandler {
        vtable: *const TimerHandlerVTable,
        references: AtomicU32,
        calls: AtomicU32,
    }

    impl MockTimerHandler {
        const fn new() -> Self {
            Self {
                vtable: &MOCK_TIMER_VTABLE,
                references: AtomicU32::new(1),
                calls: AtomicU32::new(0),
            }
        }

        fn as_interface(&mut self) -> *mut ITimerHandler {
            std::ptr::from_mut(self).cast()
        }
    }

    unsafe extern "system" fn mock_query_interface(
        this: *mut FUnknown,
        requested: *const c_char,
        output: *mut *mut c_void,
    ) -> tresult {
        if requested.is_null() || output.is_null() {
            return -2147024809;
        }
        let requested = unsafe {
            // SAFETY: VST3 queryInterface supplies one 16-byte TUID.
            std::slice::from_raw_parts(requested, 16)
        };
        if requested == iid::FUNKNOWN || requested == iid::ITIMER_HANDLER {
            unsafe {
                // SAFETY: output is writable and MockTimerHandler starts with this interface.
                output.write(this.cast());
                mock_add_ref(this);
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

    unsafe extern "system" fn mock_add_ref(this: *mut FUnknown) -> uint32 {
        let handler = this.cast::<MockTimerHandler>();
        unsafe {
            // SAFETY: this is the leading interface of the live mock handler.
            (*handler).references.fetch_add(1, Ordering::Relaxed) + 1
        }
    }

    unsafe extern "system" fn mock_release(this: *mut FUnknown) -> uint32 {
        let handler = this.cast::<MockTimerHandler>();
        unsafe {
            // SAFETY: each owned mock reference is released at most once.
            (*handler).references.fetch_sub(1, Ordering::Relaxed) - 1
        }
    }

    unsafe extern "system" fn mock_on_timer(this: *mut ITimerHandler) {
        let handler = this.cast::<MockTimerHandler>();
        unsafe {
            // SAFETY: this is the leading interface of the retained live mock handler.
            (*handler).calls.fetch_add(1, Ordering::Relaxed);
        }
    }

    static MOCK_TIMER_VTABLE: TimerHandlerVTable = TimerHandlerVTable {
        base: FUnknownVTable {
            query_interface: mock_query_interface,
            add_ref: mock_add_ref,
            release: mock_release,
        },
        on_timer: mock_on_timer,
    };
}
