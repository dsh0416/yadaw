use super::{CStr, NativeContainerGeometry, NativeParentHandle, c_void, nonzero_extent};
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

pub struct Container {
    view: *mut c_void,
    parent: *mut c_void,
    child_window: *mut c_void,
}

impl Container {
    pub fn create_for_parent(
        parent: NativeParentHandle,
        geometry: NativeContainerGeometry,
        _platform_scaled: bool,
    ) -> Result<Option<Self>, String> {
        Self::create_with_parent(parent.get() as *mut c_void, geometry, true).map(Some)
    }

    fn create_with_parent(
        parent: *mut c_void,
        geometry: NativeContainerGeometry,
        use_child_window: bool,
    ) -> Result<Self, String> {
        let frame = if use_child_window {
            rect(0, 0, geometry.frame_width, geometry.frame_height)
        } else {
            container_frame(geometry)
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
            // SAFETY: parent and parent_window are live AppKit objects on the main thread.
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
        })
    }

    pub fn attach_handle(&self) -> *mut c_void {
        self.view
    }

    pub fn resize(&mut self, geometry: NativeContainerGeometry) {
        // SAFETY: all stored AppKit objects remain live until Container::drop, and resize
        // runs on the Electron main thread that owns them.
        unsafe {
            if self.child_window.is_null() {
                // SAFETY: view is live and setFrame: accepts one NSRect by value.
                send_void_rect(
                    self.view,
                    sel_registerName(c"setFrame:".as_ptr()),
                    container_frame(geometry),
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

fn container_frame(geometry: NativeContainerGeometry) -> Rect {
    let top = u32::try_from(geometry.y).unwrap_or(0);
    let y = geometry
        .parent_height
        .saturating_sub(top)
        .saturating_sub(geometry.frame_height)
        .min(i32::MAX as u32) as i32;
    rect(geometry.x, y, geometry.frame_width, geometry.frame_height)
}

unsafe fn child_window_frame(
    parent_view: *mut c_void,
    parent_window: *mut c_void,
    geometry: NativeContainerGeometry,
) -> Rect {
    let local = container_frame(geometry);
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

        let frame = container_frame(geometry);
        assert_eq!(frame.origin.y, 0.0);
    }
}

impl Drop for Container {
    fn drop(&mut self) {
        // SAFETY: drop runs on the owning AppKit thread and balances every retained child
        // view/window created by Container::create_for_parent.
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

unsafe fn send_void_rect_bool(receiver: *mut c_void, selector: Sel, value: Rect, display: bool) {
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
