use std::{
    ffi::{CStr, c_void},
    num::NonZeroU32,
};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

#[cfg(target_os = "linux")]
use raw_window_handle::HasDisplayHandle;

pub const APPLICATION_ID: &str = "dev.yadaw.studio";

#[cfg(target_os = "windows")]
pub fn configure_process_application_identity() -> Result<(), String> {
    let mut application_id = APPLICATION_ID.encode_utf16().collect::<Vec<_>>();
    application_id.push(0);
    let result = unsafe {
        // SAFETY: application_id is a live, null-terminated UTF-16 string.
        SetCurrentProcessExplicitAppUserModelID(application_id.as_ptr())
    };
    if result < 0 {
        Err(format!(
            "SetCurrentProcessExplicitAppUserModelID failed: 0x{:08X}",
            result as u32
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
pub fn configure_process_application_identity() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
#[link(name = "shell32")]
unsafe extern "system" {
    fn SetCurrentProcessExplicitAppUserModelID(application_id: *const u16) -> i32;
}

/// A native child owned by an editor window. The VST3 view is attached to this
/// child instead of the winit top-level window so iced can keep a toolbar above
/// the plug-in without overlapping it.
pub struct NativeContainer {
    inner: platform::Container,
}

pub struct NativeUiContext {
    _inner: platform::UiContext,
}

impl NativeUiContext {
    pub fn initialize() -> Result<Self, String> {
        platform::UiContext::initialize().map(|_inner| Self { _inner })
    }
}

impl NativeContainer {
    pub fn create(
        parent: &Window,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<Option<Self>, String> {
        platform::Container::create(parent, x, y, width, height)
            .map(|container| container.map(|inner| Self { inner }))
    }

    #[must_use]
    pub fn platform_type(&self) -> &'static CStr {
        platform::PLATFORM_TYPE
    }

    #[must_use]
    pub fn attach_handle(&self) -> *mut c_void {
        self.inner.attach_handle()
    }

    pub fn resize(&mut self, x: i32, y: i32, width: u32, height: u32) {
        self.inner.resize(x, y, width, height);
    }

    pub fn focus(&self) {
        self.inner.focus();
    }

    pub fn set_visible(&self, visible: bool) {
        self.inner.set_visible(visible);
    }
}

fn nonzero_extent(value: u32) -> u32 {
    NonZeroU32::new(value).map_or(1, NonZeroU32::get)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    type Hwnd = *mut c_void;
    type Hinstance = *mut c_void;

    const WS_CHILD: u32 = 0x4000_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
    const WS_CLIPCHILDREN: u32 = 0x0200_0000;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOZORDER: u32 = 0x0004;
    const SW_HIDE: i32 = 0;
    const SW_SHOWNA: i32 = 8;

    pub const PLATFORM_TYPE: &CStr = c"HWND";

    pub struct UiContext;

    impl UiContext {
        pub fn initialize() -> Result<Self, String> {
            let result = unsafe {
                // SAFETY: the context is initialized and dropped on the winit main thread.
                OleInitialize(std::ptr::null_mut())
            };
            if result < 0 {
                Err(format!(
                    "OleInitialize failed for VST3 editor thread: 0x{:08X}",
                    result as u32
                ))
            } else {
                Ok(Self)
            }
        }
    }

    impl Drop for UiContext {
        fn drop(&mut self) {
            unsafe {
                // SAFETY: balances this context's successful OleInitialize call.
                OleUninitialize();
            }
        }
    }

    pub struct Container {
        hwnd: Hwnd,
    }

    impl Container {
        pub fn create(
            parent: &Window,
            x: i32,
            y: i32,
            width: u32,
            height: u32,
        ) -> Result<Option<Self>, String> {
            let handle = parent
                .window_handle()
                .map_err(|error| format!("could not obtain Win32 window handle: {error}"))?;
            let RawWindowHandle::Win32(handle) = handle.as_raw() else {
                return Ok(None);
            };
            let parent = handle.hwnd.get() as Hwnd;
            let hinstance = handle
                .hinstance
                .map_or(std::ptr::null_mut(), |value| value.get() as Hinstance);
            let class_name = [
                'S' as u16, 'T' as u16, 'A' as u16, 'T' as u16, 'I' as u16, 'C' as u16, 0,
            ];
            let hwnd = unsafe {
                // SAFETY: all pointers are either static UTF-16 data, null, or a live winit HWND.
                CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    std::ptr::null(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                    x,
                    y,
                    nonzero_extent(width) as i32,
                    nonzero_extent(height) as i32,
                    parent,
                    std::ptr::null_mut(),
                    hinstance,
                    std::ptr::null_mut(),
                )
            };
            if hwnd.is_null() {
                return Err("CreateWindowExW failed for VST3 child container".into());
            }
            Ok(Some(Self { hwnd }))
        }

        pub fn attach_handle(&self) -> *mut c_void {
            self.hwnd
        }

        pub fn resize(&mut self, x: i32, y: i32, width: u32, height: u32) {
            unsafe {
                // SAFETY: hwnd is live until Drop and dimensions are clamped non-zero.
                SetWindowPos(
                    self.hwnd,
                    std::ptr::null_mut(),
                    x,
                    y,
                    nonzero_extent(width) as i32,
                    nonzero_extent(height) as i32,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        }

        pub fn focus(&self) {
            unsafe {
                // SAFETY: hwnd is a live child window owned by this UI thread.
                SetFocus(self.hwnd);
            }
        }

        pub fn set_visible(&self, visible: bool) {
            unsafe {
                // SAFETY: hwnd is a live child window owned by this UI thread.
                ShowWindow(self.hwnd, if visible { SW_SHOWNA } else { SW_HIDE });
            }
        }
    }

    impl Drop for Container {
        fn drop(&mut self) {
            unsafe {
                // SAFETY: hwnd is destroyed exactly once by its owning UI thread.
                DestroyWindow(self.hwnd);
            }
        }
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: *mut c_void,
            instance: Hinstance,
            parameter: *mut c_void,
        ) -> Hwnd;
        fn SetWindowPos(
            hwnd: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
        fn SetFocus(hwnd: Hwnd) -> Hwnd;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
        fn DestroyWindow(hwnd: Hwnd) -> i32;
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn OleInitialize(reserved: *mut c_void) -> i32;
        fn OleUninitialize();
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{c_char, c_double};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: c_double,
        y: c_double,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        width: c_double,
        height: c_double,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        origin: Point,
        size: Size,
    }

    pub const PLATFORM_TYPE: &CStr = c"NSView";

    pub struct UiContext;

    impl UiContext {
        pub fn initialize() -> Result<Self, String> {
            Ok(Self)
        }
    }

    pub struct Container {
        view: *mut c_void,
    }

    impl Container {
        pub fn create(
            parent: &Window,
            x: i32,
            y: i32,
            width: u32,
            height: u32,
        ) -> Result<Option<Self>, String> {
            let handle = parent
                .window_handle()
                .map_err(|error| format!("could not obtain AppKit window handle: {error}"))?;
            let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
                return Ok(None);
            };
            let frame = rect(x, y, width, height);
            let class = unsafe {
                // SAFETY: NSView is a process-lifetime Objective-C class name.
                objc_getClass(c"NSView".as_ptr())
            };
            if class.is_null() {
                return Err("AppKit NSView class is unavailable".into());
            }
            let allocated = unsafe {
                // SAFETY: objc_msgSend is invoked with the signature of +[NSView alloc].
                send_id(class, sel_registerName(c"alloc".as_ptr()))
            };
            let view = unsafe {
                // SAFETY: allocated is an NSView allocation and frame is a valid NSRect.
                send_id_rect(
                    allocated,
                    sel_registerName(c"initWithFrame:".as_ptr()),
                    frame,
                )
            };
            if view.is_null() {
                return Err("could not allocate AppKit VST3 child view".into());
            }
            unsafe {
                // SAFETY: both objects are live NSViews on the AppKit main thread.
                send_void_id(
                    handle.ns_view.as_ptr(),
                    sel_registerName(c"addSubview:".as_ptr()),
                    view,
                );
            }
            Ok(Some(Self { view }))
        }

        pub fn attach_handle(&self) -> *mut c_void {
            self.view
        }

        pub fn resize(&mut self, x: i32, y: i32, width: u32, height: u32) {
            unsafe {
                // SAFETY: view is live and setFrame: accepts one NSRect by value.
                send_void_rect(
                    self.view,
                    sel_registerName(c"setFrame:".as_ptr()),
                    rect(x, y, width, height),
                );
            }
        }

        pub fn focus(&self) {}

        pub fn set_visible(&self, visible: bool) {
            unsafe {
                // SAFETY: view is a live NSView and setHidden: accepts one Objective-C BOOL.
                send_void_bool(
                    self.view,
                    sel_registerName(c"setHidden:".as_ptr()),
                    if visible { 0 } else { 1 },
                );
            }
        }
    }

    impl Drop for Container {
        fn drop(&mut self) {
            unsafe {
                // SAFETY: remove/release are paired with addSubview and initWithFrame.
                send_void(self.view, sel_registerName(c"removeFromSuperview".as_ptr()));
                send_void(self.view, sel_registerName(c"release".as_ptr()));
            }
        }
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            origin: Point {
                x: x.into(),
                y: y.into(),
            },
            size: Size {
                width: nonzero_extent(width).into(),
                height: nonzero_extent(height).into(),
            },
        }
    }

    type Sel = *mut c_void;
    type Class = *mut c_void;

    unsafe fn send_id(receiver: *mut c_void, selector: Sel) -> *mut c_void {
        let function: unsafe extern "C" fn(*mut c_void, Sel) -> *mut c_void =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector) }
    }

    unsafe fn send_id_rect(receiver: *mut c_void, selector: Sel, value: Rect) -> *mut c_void {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Rect) -> *mut c_void =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    unsafe fn send_void(receiver: *mut c_void, selector: Sel) {
        let function: unsafe extern "C" fn(*mut c_void, Sel) =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector) }
    }

    unsafe fn send_void_id(receiver: *mut c_void, selector: Sel, value: *mut c_void) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, *mut c_void) =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    unsafe fn send_void_rect(receiver: *mut c_void, selector: Sel, value: Rect) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Rect) =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    unsafe fn send_void_bool(receiver: *mut c_void, selector: Sel, value: i8) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, i8) =
            unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Class;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::ffi::{c_char, c_int, c_long, c_ulong};

    type Display = c_void;
    type XWindow = c_ulong;
    type Atom = c_ulong;

    const EXPOSURE_MASK: c_long = 1 << 15;
    const STRUCTURE_NOTIFY_MASK: c_long = 1 << 17;
    const FOCUS_CHANGE_MASK: c_long = 1 << 21;
    const KEY_PRESS_MASK: c_long = 1;
    const KEY_RELEASE_MASK: c_long = 1 << 1;
    const BUTTON_PRESS_MASK: c_long = 1 << 2;
    const BUTTON_RELEASE_MASK: c_long = 1 << 3;
    const POINTER_MOTION_MASK: c_long = 1 << 6;
    const REVERT_TO_PARENT: c_int = 2;
    const CURRENT_TIME: c_ulong = 0;
    const PROP_MODE_REPLACE: c_int = 0;

    pub const PLATFORM_TYPE: &CStr = c"X11EmbedWindowID";

    pub struct UiContext;

    impl UiContext {
        pub fn initialize() -> Result<Self, String> {
            Ok(Self)
        }
    }

    pub struct Container {
        display: *mut Display,
        window: XWindow,
    }

    impl Container {
        pub fn create(
            parent: &Window,
            x: i32,
            y: i32,
            width: u32,
            height: u32,
        ) -> Result<Option<Self>, String> {
            let window_handle = parent
                .window_handle()
                .map_err(|error| format!("could not obtain X11 window handle: {error}"))?;
            let display_handle = parent
                .display_handle()
                .map_err(|error| format!("could not obtain X11 display handle: {error}"))?;
            let (RawWindowHandle::Xlib(parent), raw_window_handle::RawDisplayHandle::Xlib(display)) =
                (window_handle.as_raw(), display_handle.as_raw())
            else {
                return Ok(None);
            };
            let Some(display) = display.display else {
                return Err("winit X11 display handle is null".into());
            };
            let display = display.as_ptr();
            let window = unsafe {
                // SAFETY: display and parent window are borrowed from the live winit window.
                XCreateSimpleWindow(
                    display,
                    parent.window,
                    x,
                    y,
                    nonzero_extent(width),
                    nonzero_extent(height),
                    0,
                    0,
                    0,
                )
            };
            if window == 0 {
                return Err("XCreateSimpleWindow failed for VST3 child container".into());
            }
            unsafe {
                // SAFETY: display/window are live and the selected event mask is valid.
                XSelectInput(
                    display,
                    window,
                    EXPOSURE_MASK
                        | STRUCTURE_NOTIFY_MASK
                        | FOCUS_CHANGE_MASK
                        | KEY_PRESS_MASK
                        | KEY_RELEASE_MASK
                        | BUTTON_PRESS_MASK
                        | BUTTON_RELEASE_MASK
                        | POINTER_MOTION_MASK,
                );
                set_xembed_info(display, window);
                XMapWindow(display, window);
                XFlush(display);
            }
            Ok(Some(Self { display, window }))
        }

        pub fn attach_handle(&self) -> *mut c_void {
            self.window as usize as *mut c_void
        }

        pub fn resize(&mut self, x: i32, y: i32, width: u32, height: u32) {
            unsafe {
                // SAFETY: display/window remain live until Drop.
                XMoveResizeWindow(
                    self.display,
                    self.window,
                    x,
                    y,
                    nonzero_extent(width),
                    nonzero_extent(height),
                );
                XFlush(self.display);
            }
        }

        pub fn focus(&self) {
            unsafe {
                // SAFETY: display/window remain live until Drop.
                XSetInputFocus(self.display, self.window, REVERT_TO_PARENT, CURRENT_TIME);
                XFlush(self.display);
            }
        }

        pub fn set_visible(&self, visible: bool) {
            unsafe {
                // SAFETY: display/window remain live until Drop.
                if visible {
                    XMapWindow(self.display, self.window);
                } else {
                    XUnmapWindow(self.display, self.window);
                }
                XFlush(self.display);
            }
        }
    }

    impl Drop for Container {
        fn drop(&mut self) {
            unsafe {
                // SAFETY: the child is destroyed exactly once before the parent window.
                XDestroyWindow(self.display, self.window);
                XFlush(self.display);
            }
        }
    }

    unsafe fn set_xembed_info(display: *mut Display, window: XWindow) {
        let property = unsafe {
            // SAFETY: display is a live X11 connection and the atom name is a static C string.
            XInternAtom(display, c"_XEMBED_INFO".as_ptr(), 0)
        };
        let cardinal = unsafe {
            // SAFETY: display is a live X11 connection and the atom name is a static C string.
            XInternAtom(display, c"CARDINAL".as_ptr(), 0)
        };
        let values = [0_u32, 1_u32];
        unsafe {
            // SAFETY: display/window are live, atoms were interned above, and values outlives the call.
            XChangeProperty(
                display,
                window,
                property,
                cardinal,
                32,
                PROP_MODE_REPLACE,
                values.as_ptr().cast(),
                values.len() as c_int,
            );
        }
    }

    #[link(name = "X11")]
    unsafe extern "C" {
        fn XCreateSimpleWindow(
            display: *mut Display,
            parent: XWindow,
            x: c_int,
            y: c_int,
            width: u32,
            height: u32,
            border_width: u32,
            border: c_ulong,
            background: c_ulong,
        ) -> XWindow;
        fn XSelectInput(display: *mut Display, window: XWindow, event_mask: c_long) -> c_int;
        fn XInternAtom(
            display: *mut Display,
            atom_name: *const c_char,
            only_if_exists: c_int,
        ) -> Atom;
        fn XChangeProperty(
            display: *mut Display,
            window: XWindow,
            property: Atom,
            property_type: Atom,
            format: c_int,
            mode: c_int,
            data: *const u8,
            element_count: c_int,
        ) -> c_int;
        fn XMapWindow(display: *mut Display, window: XWindow) -> c_int;
        fn XUnmapWindow(display: *mut Display, window: XWindow) -> c_int;
        fn XMoveResizeWindow(
            display: *mut Display,
            window: XWindow,
            x: c_int,
            y: c_int,
            width: u32,
            height: u32,
        ) -> c_int;
        fn XSetInputFocus(
            display: *mut Display,
            focus: XWindow,
            revert_to: c_int,
            time: c_ulong,
        ) -> c_int;
        fn XDestroyWindow(display: *mut Display, window: XWindow) -> c_int;
        fn XFlush(display: *mut Display) -> c_int;
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;

    pub const PLATFORM_TYPE: &CStr = c"unsupported";

    pub struct UiContext;

    impl UiContext {
        pub fn initialize() -> Result<Self, String> {
            Ok(Self)
        }
    }

    pub struct Container;

    impl Container {
        pub fn create(
            _parent: &Window,
            _x: i32,
            _y: i32,
            _width: u32,
            _height: u32,
        ) -> Result<Option<Self>, String> {
            Ok(None)
        }

        pub fn attach_handle(&self) -> *mut c_void {
            std::ptr::null_mut()
        }

        pub fn resize(&mut self, _x: i32, _y: i32, _width: u32, _height: u32) {}

        pub fn focus(&self) {}

        pub fn set_visible(&self, _visible: bool) {}
    }
}
