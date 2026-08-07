use super::{CStr, NativeContainerGeometry, NativeParentHandle, c_void, nonzero_extent};
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

pub struct EditorWindowContext;

impl EditorWindowContext {
    pub fn begin() -> Self {
        Self
    }

    pub fn supports_platform_scale_fallback(&self) -> bool {
        false
    }
}

pub fn with_native_child_scale_context<T>(
    _platform_scaled: bool,
    operation: impl FnOnce() -> T,
) -> T {
    operation()
}

pub struct UiContext;

impl UiContext {
    pub fn initialize() -> Result<Self, String> {
        Ok(Self)
    }
}

pub struct Container {
    display: *mut Display,
    window: XWindow,
    owns_display: bool,
}

impl Container {
    pub fn create_for_parent(
        parent: NativeParentHandle,
        geometry: NativeContainerGeometry,
        _platform_scaled: bool,
    ) -> Result<Option<Self>, String> {
        let display = unsafe {
            // SAFETY: null asks Xlib to open the process's configured default display.
            XOpenDisplay(std::ptr::null())
        };
        if display.is_null() {
            return Ok(None);
        }
        match Self::create_with_parent(display, parent.get() as XWindow, geometry, true) {
            Ok(container) => Ok(Some(container)),
            Err(error) => {
                unsafe {
                    // SAFETY: display was opened by this function and no child owns it.
                    XCloseDisplay(display);
                }
                Err(error)
            }
        }
    }

    fn create_with_parent(
        display: *mut Display,
        parent: XWindow,
        geometry: NativeContainerGeometry,
        owns_display: bool,
    ) -> Result<Self, String> {
        let window = unsafe {
            // SAFETY: display is live and parent is the registered Electron X11 window.
            XCreateSimpleWindow(
                display,
                parent,
                geometry.x,
                geometry.y,
                nonzero_extent(geometry.frame_width),
                nonzero_extent(geometry.frame_height),
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
        Ok(Self {
            display,
            window,
            owns_display,
        })
    }

    pub fn attach_handle(&self) -> *mut c_void {
        self.window as usize as *mut c_void
    }

    pub fn resize(&mut self, geometry: NativeContainerGeometry) {
        unsafe {
            // SAFETY: display/window remain live until Drop.
            XMoveResizeWindow(
                self.display,
                self.window,
                geometry.x,
                geometry.y,
                nonzero_extent(geometry.frame_width),
                nonzero_extent(geometry.frame_height),
            );
            // Chromium may create its compositor child after this XEmbed
            // container. Keep the native editor above that sibling when
            // Electron sends the post-attachment layout.
            XRaiseWindow(self.display, self.window);
            XFlush(self.display);
        }
    }

    pub fn focus(&self) {
        unsafe {
            // SAFETY: display/window remain live until Drop.
            XRaiseWindow(self.display, self.window);
            XSetInputFocus(self.display, self.window, REVERT_TO_PARENT, CURRENT_TIME);
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
            if self.owns_display {
                XCloseDisplay(self.display);
            }
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
    // Xlib requires format-32 property data to be an array of C longs,
    // including on LP64 where each element occupies eight bytes.
    let values: [c_ulong; 2] = [0, 1];
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
    fn XOpenDisplay(display_name: *const c_char) -> *mut Display;
    fn XCloseDisplay(display: *mut Display) -> c_int;
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
    fn XInternAtom(display: *mut Display, atom_name: *const c_char, only_if_exists: c_int) -> Atom;
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
    fn XMoveResizeWindow(
        display: *mut Display,
        window: XWindow,
        x: c_int,
        y: c_int,
        width: u32,
        height: u32,
    ) -> c_int;
    fn XRaiseWindow(display: *mut Display, window: XWindow) -> c_int;
    fn XSetInputFocus(
        display: *mut Display,
        focus: XWindow,
        revert_to: c_int,
        time: c_ulong,
    ) -> c_int;
    fn XDestroyWindow(display: *mut Display, window: XWindow) -> c_int;
    fn XFlush(display: *mut Display) -> c_int;
}
