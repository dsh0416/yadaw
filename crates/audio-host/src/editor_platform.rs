use std::{
    ffi::{CStr, c_void},
    num::{NonZeroU32, NonZeroUsize},
};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

#[cfg(target_os = "linux")]
use raw_window_handle::HasDisplayHandle;

pub const APPLICATION_ID: &str = "live.minori.heron";

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

#[derive(Debug, Clone, Copy)]
pub struct NativeParentHandle(NonZeroUsize);

impl NativeParentHandle {
    /// # Safety
    ///
    /// `value` must identify a live Electron content view/window for the current
    /// platform. The caller must keep that parent alive until every child
    /// [`NativeContainer`] has been dropped, and all operations must occur on
    /// the platform UI thread that owns the parent.
    pub unsafe fn from_raw(value: usize) -> Option<Self> {
        NonZeroUsize::new(value).map(Self)
    }

    fn get(self) -> usize {
        self.0.get()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeContainerGeometry {
    pub x: i32,
    /// Distance from the top edge of the parent content surface.
    pub y: i32,
    /// Height of the parent content surface in the same coordinate space.
    pub parent_height: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    pub content_width: u32,
    pub content_height: u32,
}

pub struct NativeUiContext {
    _inner: platform::UiContext,
}

/// Scoped platform state applied while a top-level plug-in editor window is
/// created. On Windows this records mixed-DPI hosting on the new HWND without
/// changing that window's own per-monitor DPI awareness.
pub struct NativeEditorWindowContext {
    inner: platform::EditorWindowContext,
}

impl NativeEditorWindowContext {
    #[must_use]
    pub fn begin() -> Self {
        Self {
            inner: platform::EditorWindowContext::begin(),
        }
    }

    #[must_use]
    pub fn supports_platform_scale_fallback(&self) -> bool {
        self.inner.supports_platform_scale_fallback()
    }
}

impl NativeUiContext {
    pub fn initialize() -> Result<Self, String> {
        platform::UiContext::initialize().map(|_inner| Self { _inner })
    }
}

impl NativeContainer {
    pub fn create(
        parent: &Window,
        geometry: NativeContainerGeometry,
        platform_scaled: bool,
    ) -> Result<Option<Self>, String> {
        platform::Container::create(parent, geometry, platform_scaled)
            .map(|container| container.map(|inner| Self { inner }))
    }

    pub fn create_for_parent(
        parent: NativeParentHandle,
        geometry: NativeContainerGeometry,
        platform_scaled: bool,
    ) -> Result<Option<Self>, String> {
        platform::Container::create_for_parent(parent, geometry, platform_scaled)
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

    pub fn resize(&mut self, geometry: NativeContainerGeometry) {
        self.inner.resize(geometry);
    }

    pub fn focus(&self) {
        self.inner.focus();
    }
}

pub fn with_native_child_scale_context<T>(
    platform_scaled: bool,
    operation: impl FnOnce() -> T,
) -> T {
    platform::with_native_child_scale_context(platform_scaled, operation)
}

fn nonzero_extent(value: u32) -> u32 {
    NonZeroU32::new(value).map_or(1, NonZeroU32::get)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{
        CStr, HasWindowHandle, NativeContainerGeometry, NativeParentHandle, RawWindowHandle,
        Window, c_void, nonzero_extent,
    };

    mod dpi {
        include!("editor_platform/windows_dpi.rs");
    }

    type Hwnd = *mut c_void;
    type Hinstance = *mut c_void;

    const WS_CHILD: u32 = 0x4000_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
    const WS_CLIPCHILDREN: u32 = 0x0200_0000;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOZORDER: u32 = 0x0004;
    pub const PLATFORM_TYPE: &CStr = c"HWND";

    pub use dpi::EditorWindowContext;

    pub fn with_native_child_scale_context<T>(
        platform_scaled: bool,
        operation: impl FnOnce() -> T,
    ) -> T {
        dpi::with_native_child_scale_context(platform_scaled, operation)
    }

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
            geometry: NativeContainerGeometry,
            platform_scaled: bool,
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
            Self::create_with_parent(parent, hinstance, geometry, platform_scaled).map(Some)
        }

        pub fn create_for_parent(
            parent: NativeParentHandle,
            geometry: NativeContainerGeometry,
            platform_scaled: bool,
        ) -> Result<Option<Self>, String> {
            let hinstance = unsafe {
                // SAFETY: null requests the module handle of the current process.
                GetModuleHandleW(std::ptr::null())
            };
            Self::create_with_parent(parent.get() as Hwnd, hinstance, geometry, platform_scaled)
                .map(Some)
        }

        fn create_with_parent(
            parent: Hwnd,
            hinstance: Hinstance,
            geometry: NativeContainerGeometry,
            platform_scaled: bool,
        ) -> Result<Self, String> {
            let class_name = [
                'S' as u16, 'T' as u16, 'A' as u16, 'T' as u16, 'I' as u16, 'C' as u16, 0,
            ];
            let hwnd = with_native_child_scale_context(platform_scaled, || unsafe {
                // SAFETY: all pointers are either static UTF-16 data, null, or a live winit HWND.
                CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    std::ptr::null(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                    geometry.x,
                    geometry.y,
                    nonzero_extent(geometry.frame_width) as i32,
                    nonzero_extent(geometry.frame_height) as i32,
                    parent,
                    std::ptr::null_mut(),
                    hinstance,
                    std::ptr::null_mut(),
                )
            });
            if hwnd.is_null() {
                return Err("CreateWindowExW failed for VST3 child container".into());
            }
            Ok(Self { hwnd })
        }

        pub fn attach_handle(&self) -> *mut c_void {
            self.hwnd
        }

        pub fn resize(&mut self, geometry: NativeContainerGeometry) {
            unsafe {
                // SAFETY: hwnd is live until Drop and dimensions are clamped non-zero.
                SetWindowPos(
                    self.hwnd,
                    std::ptr::null_mut(),
                    geometry.x,
                    geometry.y,
                    nonzero_extent(geometry.frame_width) as i32,
                    nonzero_extent(geometry.frame_height) as i32,
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
        fn DestroyWindow(hwnd: Hwnd) -> i32;
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn OleInitialize(reserved: *mut c_void) -> i32;
        fn OleUninitialize();
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(module_name: *const u16) -> Hinstance;
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{
        CStr, HasWindowHandle, NativeContainerGeometry, NativeParentHandle, RawWindowHandle,
        Window, c_void, nonzero_extent,
    };
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

    pub struct EditorWindowContext;

    impl EditorWindowContext {
        pub fn begin() -> Self {
            Self
        }

        pub fn supports_platform_scale_fallback(&self) -> bool {
            true
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

    #[derive(Clone, Copy)]
    enum ParentCoordinates {
        TopLeft,
        BottomLeft,
    }

    pub struct Container {
        view: *mut c_void,
        parent: *mut c_void,
        child_window: *mut c_void,
        parent_coordinates: ParentCoordinates,
    }

    impl Container {
        pub fn create(
            parent: &Window,
            geometry: NativeContainerGeometry,
            _platform_scaled: bool,
        ) -> Result<Option<Self>, String> {
            let handle = parent
                .window_handle()
                .map_err(|error| format!("could not obtain AppKit window handle: {error}"))?;
            let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
                return Ok(None);
            };
            Self::create_with_parent(
                handle.ns_view.as_ptr(),
                geometry,
                ParentCoordinates::TopLeft,
                false,
            )
            .map(Some)
        }

        pub fn create_for_parent(
            parent: NativeParentHandle,
            geometry: NativeContainerGeometry,
            _platform_scaled: bool,
        ) -> Result<Option<Self>, String> {
            Self::create_with_parent(
                parent.get() as *mut c_void,
                geometry,
                ParentCoordinates::BottomLeft,
                true,
            )
            .map(Some)
        }

        fn create_with_parent(
            parent: *mut c_void,
            geometry: NativeContainerGeometry,
            parent_coordinates: ParentCoordinates,
            use_child_window: bool,
        ) -> Result<Self, String> {
            let frame = if use_child_window {
                rect(0, 0, geometry.frame_width, geometry.frame_height)
            } else {
                container_frame(geometry, parent_coordinates)
            };
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
            let child_window = if use_child_window {
                let parent_window = unsafe {
                    // SAFETY: parent is Electron's live content NSView.
                    send_id(parent, sel_registerName(c"window".as_ptr()))
                };
                if parent_window.is_null() {
                    unsafe {
                        // SAFETY: balances initWithFrame: before returning the error.
                        send_void(view, sel_registerName(c"release".as_ptr()));
                    }
                    return Err("Electron editor parent has no AppKit window".into());
                }
                let window_class = unsafe {
                    // SAFETY: NSWindow is a process-lifetime Objective-C class name.
                    objc_getClass(c"NSWindow".as_ptr())
                };
                if window_class.is_null() {
                    unsafe {
                        // SAFETY: balances initWithFrame: before returning the error.
                        send_void(view, sel_registerName(c"release".as_ptr()));
                    }
                    return Err("AppKit NSWindow class is unavailable".into());
                }
                let screen_frame = unsafe { child_window_frame(parent, parent_window, geometry) };
                let allocated_window = unsafe {
                    // SAFETY: objc_msgSend is invoked with the signature of +[NSWindow alloc].
                    send_id(window_class, sel_registerName(c"alloc".as_ptr()))
                };
                let child_window = unsafe {
                    // SAFETY: allocated_window is an NSWindow allocation and arguments match
                    // initWithContentRect:styleMask:backing:defer:.
                    send_id_rect_usize_usize_bool(
                        allocated_window,
                        sel_registerName(c"initWithContentRect:styleMask:backing:defer:".as_ptr()),
                        screen_frame,
                        0,
                        2,
                        false,
                    )
                };
                if child_window.is_null() {
                    unsafe {
                        // SAFETY: balances initWithFrame: before returning the error.
                        send_void(view, sel_registerName(c"release".as_ptr()));
                    }
                    return Err("could not allocate AppKit VST3 child window".into());
                }
                unsafe {
                    // SAFETY: these are live AppKit objects on the main thread. The child is
                    // retained by this Container and removed before the Electron parent dies.
                    send_void_bool(
                        child_window,
                        sel_registerName(c"setReleasedWhenClosed:".as_ptr()),
                        false,
                    );
                    send_void_bool(
                        child_window,
                        sel_registerName(c"setHasShadow:".as_ptr()),
                        false,
                    );
                    send_void_bool(
                        child_window,
                        sel_registerName(c"setIgnoresMouseEvents:".as_ptr()),
                        false,
                    );
                    send_void_id(
                        child_window,
                        sel_registerName(c"setContentView:".as_ptr()),
                        view,
                    );
                    send_void_id_isize(
                        parent_window,
                        sel_registerName(c"addChildWindow:ordered:".as_ptr()),
                        child_window,
                        1,
                    );
                    send_void_id(
                        child_window,
                        sel_registerName(c"orderFront:".as_ptr()),
                        std::ptr::null_mut(),
                    );
                }
                child_window
            } else {
                unsafe {
                    // SAFETY: both objects are live NSViews on the AppKit main thread.
                    send_void_id(parent, sel_registerName(c"addSubview:".as_ptr()), view);
                }
                std::ptr::null_mut()
            };
            unsafe {
                // SAFETY: the container owns its coordinate system; keeping bounds at the
                // plug-in's original size scales all attached descendant views into frame.
                send_void_rect(
                    view,
                    sel_registerName(c"setBounds:".as_ptr()),
                    rect(0, 0, geometry.content_width, geometry.content_height),
                );
            }
            Ok(Self {
                view,
                parent,
                child_window,
                parent_coordinates,
            })
        }

        pub fn attach_handle(&self) -> *mut c_void {
            self.view
        }

        pub fn resize(&mut self, geometry: NativeContainerGeometry) {
            unsafe {
                if self.child_window.is_null() {
                    // SAFETY: view is live and setFrame: accepts one NSRect by value.
                    send_void_rect(
                        self.view,
                        sel_registerName(c"setFrame:".as_ptr()),
                        container_frame(geometry, self.parent_coordinates),
                    );
                } else {
                    let parent_window = send_id(self.parent, sel_registerName(c"window".as_ptr()));
                    if !parent_window.is_null() {
                        send_void_rect_bool(
                            self.child_window,
                            sel_registerName(c"setFrame:display:".as_ptr()),
                            child_window_frame(self.parent, parent_window, geometry),
                            true,
                        );
                    }
                    send_void_rect(
                        self.view,
                        sel_registerName(c"setFrame:".as_ptr()),
                        rect(0, 0, geometry.frame_width, geometry.frame_height),
                    );
                }
                // SAFETY: setBounds: uses the same ABI and preserves the plug-in's logical
                // coordinate size while AppKit maps it into the scaled frame.
                send_void_rect(
                    self.view,
                    sel_registerName(c"setBounds:".as_ptr()),
                    rect(0, 0, geometry.content_width, geometry.content_height),
                );
            }
        }

        pub fn focus(&self) {
            unsafe {
                // SAFETY: view is a live NSView owned by this container. Its window and
                // first plug-in subview, when present, are borrowed only for this AppKit turn.
                let superview = send_id(self.view, sel_registerName(c"superview".as_ptr()));
                if self.child_window.is_null() && !superview.is_null() {
                    // SAFETY: re-adding an existing subview with NSWindowAbove only updates its
                    // sibling order. This keeps Electron's bridge views from winning hit tests.
                    send_void_id_isize_id(
                        superview,
                        sel_registerName(c"addSubview:positioned:relativeTo:".as_ptr()),
                        self.view,
                        1,
                        std::ptr::null_mut(),
                    );
                    if std::env::var_os("HERON_EDITOR_HIT_TEST_DEBUG").is_some() {
                        let bounds = send_rect(self.view, sel_registerName(c"bounds".as_ptr()));
                        let point = Point {
                            x: bounds.origin.x + bounds.size.width / 2.0,
                            y: bounds.origin.y + bounds.size.height / 2.0,
                        };
                        let point = send_point_point_id(
                            self.view,
                            sel_registerName(c"convertPoint:toView:".as_ptr()),
                            point,
                            superview,
                        );
                        let hit =
                            send_id_point(superview, sel_registerName(c"hitTest:".as_ptr()), point);
                        let plugin_hit = hit == self.view
                            || (!hit.is_null()
                                && send_bool_id(
                                    hit,
                                    sel_registerName(c"isDescendantOf:".as_ptr()),
                                    self.view,
                                ));
                        eprintln!(
                            "audio-host: AppKit editor hit test view={:p} hit={hit:p} plugin={plugin_hit}",
                            self.view
                        );
                    }
                }
                let window = send_id(self.view, sel_registerName(c"window".as_ptr()));
                if window.is_null() {
                    return;
                }
                send_void_bool(
                    window,
                    sel_registerName(c"setIgnoresMouseEvents:".as_ptr()),
                    false,
                );
                send_void_bool(
                    window,
                    sel_registerName(c"setAcceptsMouseMovedEvents:".as_ptr()),
                    true,
                );
                send_void(window, sel_registerName(c"makeKeyWindow".as_ptr()));
                let subviews = send_id(self.view, sel_registerName(c"subviews".as_ptr()));
                let plugin_view = if subviews.is_null() {
                    std::ptr::null_mut()
                } else {
                    send_id(subviews, sel_registerName(c"firstObject".as_ptr()))
                };
                let responder = if plugin_view.is_null() {
                    self.view
                } else {
                    plugin_view
                };
                let _ = send_bool_id(
                    window,
                    sel_registerName(c"makeFirstResponder:".as_ptr()),
                    responder,
                );
            }
        }
    }

    fn container_frame(
        geometry: NativeContainerGeometry,
        parent_coordinates: ParentCoordinates,
    ) -> Rect {
        let y = match parent_coordinates {
            ParentCoordinates::TopLeft => geometry.y,
            ParentCoordinates::BottomLeft => {
                let top = u32::try_from(geometry.y).unwrap_or(0);
                geometry
                    .parent_height
                    .saturating_sub(top)
                    .saturating_sub(geometry.frame_height)
                    .min(i32::MAX as u32) as i32
            }
        };
        rect(geometry.x, y, geometry.frame_width, geometry.frame_height)
    }

    unsafe fn child_window_frame(
        parent_view: *mut c_void,
        parent_window: *mut c_void,
        geometry: NativeContainerGeometry,
    ) -> Rect {
        let local = container_frame(geometry, ParentCoordinates::BottomLeft);
        let window = unsafe {
            // SAFETY: parent_view is a live NSView and nil requests window-base coordinates.
            send_rect_rect_id(
                parent_view,
                sel_registerName(c"convertRect:toView:".as_ptr()),
                local,
                std::ptr::null_mut(),
            )
        };
        unsafe {
            // SAFETY: parent_window is live and window is expressed in its base coordinates.
            send_rect_rect(
                parent_window,
                sel_registerName(c"convertRectToScreen:".as_ptr()),
                window,
            )
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn electron_bottom_left_parent_keeps_top_toolbar_clear() {
            let geometry = NativeContainerGeometry {
                x: 0,
                y: 60,
                parent_height: 660,
                frame_width: 800,
                frame_height: 600,
                content_width: 800,
                content_height: 600,
            };

            let frame = container_frame(geometry, ParentCoordinates::BottomLeft);
            assert_eq!(frame.origin.y, 0.0);
            let frame = container_frame(geometry, ParentCoordinates::TopLeft);
            assert_eq!(frame.origin.y, 60.0);
        }
    }

    impl Drop for Container {
        fn drop(&mut self) {
            unsafe {
                if self.child_window.is_null() {
                    // SAFETY: remove/release are paired with addSubview and initWithFrame.
                    send_void(self.view, sel_registerName(c"removeFromSuperview".as_ptr()));
                } else {
                    let parent_window = send_id(self.parent, sel_registerName(c"window".as_ptr()));
                    if !parent_window.is_null() {
                        send_void_id(
                            parent_window,
                            sel_registerName(c"removeChildWindow:".as_ptr()),
                            self.child_window,
                        );
                    }
                    send_void_id(
                        self.child_window,
                        sel_registerName(c"orderOut:".as_ptr()),
                        std::ptr::null_mut(),
                    );
                    send_void_id(
                        self.child_window,
                        sel_registerName(c"setContentView:".as_ptr()),
                        std::ptr::null_mut(),
                    );
                    send_void(self.child_window, sel_registerName(c"close".as_ptr()));
                    send_void(self.child_window, sel_registerName(c"release".as_ptr()));
                }
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
        let function: unsafe extern "C" fn(*mut c_void, Sel) -> *mut c_void = unsafe {
            // SAFETY: casts objc_msgSend to the id-returning selector signature used below.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver and selector form a valid Objective-C message for this signature.
            function(receiver, selector)
        }
    }

    unsafe fn send_id_rect(receiver: *mut c_void, selector: Sel, value: Rect) -> *mut c_void {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Rect) -> *mut c_void = unsafe {
            // SAFETY: casts objc_msgSend to the id/Rect selector signature used below.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, and Rect argument match this Objective-C message.
            function(receiver, selector, value)
        }
    }

    unsafe fn send_id_rect_usize_usize_bool(
        receiver: *mut c_void,
        selector: Sel,
        rect: Rect,
        style_mask: usize,
        backing: usize,
        defer: bool,
    ) -> *mut c_void {
        let function: unsafe extern "C" fn(
            *mut c_void,
            Sel,
            Rect,
            usize,
            usize,
            c_char,
        ) -> *mut c_void = unsafe {
            // SAFETY: casts objc_msgSend to the NSWindow initializer signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver and arguments match the NSWindow initializer.
            function(
                receiver,
                selector,
                rect,
                style_mask,
                backing,
                c_char::from(defer),
            )
        }
    }

    unsafe fn send_rect_rect(receiver: *mut c_void, selector: Sel, value: Rect) -> Rect {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Rect) -> Rect = unsafe {
            // SAFETY: casts objc_msgSend to the NSRect/NSRect selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, and NSRect match convertRectToScreen:.
            function(receiver, selector, value)
        }
    }

    unsafe fn send_rect_rect_id(
        receiver: *mut c_void,
        selector: Sel,
        value: Rect,
        view: *mut c_void,
    ) -> Rect {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Rect, *mut c_void) -> Rect = unsafe {
            // SAFETY: casts objc_msgSend to the NSRect/NSRect/id selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, NSRect, and NSView match convertRect:toView:.
            function(receiver, selector, value, view)
        }
    }

    unsafe fn send_id_point(receiver: *mut c_void, selector: Sel, value: Point) -> *mut c_void {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Point) -> *mut c_void = unsafe {
            // SAFETY: casts objc_msgSend to the id/NSPoint selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, and NSPoint argument match hitTest:.
            function(receiver, selector, value)
        }
    }

    unsafe fn send_point_point_id(
        receiver: *mut c_void,
        selector: Sel,
        point: Point,
        view: *mut c_void,
    ) -> Point {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Point, *mut c_void) -> Point = unsafe {
            // SAFETY: casts objc_msgSend to the NSPoint/NSPoint/id selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, NSPoint, and NSView match convertPoint:toView:.
            function(receiver, selector, point, view)
        }
    }

    unsafe fn send_rect(receiver: *mut c_void, selector: Sel) -> Rect {
        let function: unsafe extern "C" fn(*mut c_void, Sel) -> Rect = unsafe {
            // SAFETY: casts objc_msgSend to the NSRect-returning selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver and selector match NSView bounds.
            function(receiver, selector)
        }
    }

    unsafe fn send_void(receiver: *mut c_void, selector: Sel) {
        let function: unsafe extern "C" fn(*mut c_void, Sel) = unsafe {
            // SAFETY: casts objc_msgSend to the void selector signature used below.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver and selector form a valid Objective-C message for this signature.
            function(receiver, selector)
        }
    }

    unsafe fn send_void_id(receiver: *mut c_void, selector: Sel, value: *mut c_void) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, *mut c_void) = unsafe {
            // SAFETY: casts objc_msgSend to the void/id selector signature used below.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, and object argument match this Objective-C message.
            function(receiver, selector, value)
        }
    }

    unsafe fn send_void_id_isize(
        receiver: *mut c_void,
        selector: Sel,
        value: *mut c_void,
        order: isize,
    ) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, *mut c_void, isize) = unsafe {
            // SAFETY: casts objc_msgSend to the void/id/NSInteger selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver and arguments match addChildWindow:ordered:.
            function(receiver, selector, value, order);
        }
    }

    unsafe fn send_void_rect_bool(
        receiver: *mut c_void,
        selector: Sel,
        value: Rect,
        display: bool,
    ) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Rect, c_char) = unsafe {
            // SAFETY: casts objc_msgSend to the void/NSRect/BOOL selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver and arguments match setFrame:display:.
            function(receiver, selector, value, c_char::from(display));
        }
    }

    unsafe fn send_void_id_isize_id(
        receiver: *mut c_void,
        selector: Sel,
        first: *mut c_void,
        second: isize,
        third: *mut c_void,
    ) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, *mut c_void, isize, *mut c_void) = unsafe {
            // SAFETY: casts objc_msgSend to the id/NSInteger/id selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver and arguments match addSubview:positioned:relativeTo:.
            function(receiver, selector, first, second, third);
        }
    }

    unsafe fn send_void_bool(receiver: *mut c_void, selector: Sel, value: bool) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, c_char) = unsafe {
            // SAFETY: casts objc_msgSend to the void/BOOL selector signature.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, and BOOL argument match this AppKit setter.
            function(receiver, selector, c_char::from(value));
        }
    }

    unsafe fn send_bool_id(receiver: *mut c_void, selector: Sel, value: *mut c_void) -> bool {
        let function: unsafe extern "C" fn(*mut c_void, Sel, *mut c_void) -> c_char = unsafe {
            // SAFETY: casts objc_msgSend to the BOOL/id selector signature used below.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, and id argument match makeFirstResponder:.
            function(receiver, selector, value) != 0
        }
    }

    unsafe fn send_void_rect(receiver: *mut c_void, selector: Sel, value: Rect) {
        let function: unsafe extern "C" fn(*mut c_void, Sel, Rect) = unsafe {
            // SAFETY: casts objc_msgSend to the void/Rect selector signature used below.
            std::mem::transmute(objc_msgSend as *const ())
        };
        unsafe {
            // SAFETY: receiver, selector, and Rect argument match this Objective-C message.
            function(receiver, selector, value)
        }
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
    use super::{
        CStr, HasDisplayHandle, HasWindowHandle, NativeContainerGeometry, NativeParentHandle,
        RawWindowHandle, Window, c_void, nonzero_extent,
    };
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
        pub fn create(
            parent: &Window,
            geometry: NativeContainerGeometry,
            _platform_scaled: bool,
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
            Self::create_with_parent(display, parent.window, geometry, false).map(Some)
        }

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
                // SAFETY: display and parent window are borrowed from the live winit window.
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
    use super::{CStr, NativeContainerGeometry, NativeParentHandle, Window, c_void};

    pub const PLATFORM_TYPE: &CStr = c"unsupported";

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

    pub struct Container;

    impl Container {
        pub fn create(
            _parent: &Window,
            _geometry: NativeContainerGeometry,
            _platform_scaled: bool,
        ) -> Result<Option<Self>, String> {
            Ok(None)
        }

        pub fn create_for_parent(
            _parent: NativeParentHandle,
            _geometry: NativeContainerGeometry,
            _platform_scaled: bool,
        ) -> Result<Option<Self>, String> {
            Ok(None)
        }

        pub fn attach_handle(&self) -> *mut c_void {
            std::ptr::null_mut()
        }

        pub fn resize(&mut self, _geometry: NativeContainerGeometry) {}

        pub fn focus(&self) {}
    }
}
