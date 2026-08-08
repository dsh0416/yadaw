use super::{CStr, NativeContainerGeometry, NativeParentHandle, c_void, nonzero_extent};

mod dpi {
    include!("windows_dpi.rs");
}

type Hwnd = *mut c_void;
type Hinstance = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

const WS_CHILD: u32 = 0x4000_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
const WS_CLIPCHILDREN: u32 = 0x0200_0000;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_NOZORDER: u32 = 0x0004;
const GW_CHILD: u32 = 5;
const WM_CONTEXTMENU: u32 = 0x007B;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_MBUTTONDBLCLK: u32 = 0x0209;
const WM_MOUSEWHEEL: u32 = 0x020A;
const WM_XBUTTONDOWN: u32 = 0x020B;
const WM_XBUTTONDBLCLK: u32 = 0x020D;
const WM_MOUSEHWHEEL: u32 = 0x020E;
const WM_POINTERUPDATE: u32 = 0x0245;
const WM_POINTERDOWN: u32 = 0x0246;
const WM_POINTERUP: u32 = 0x0247;
const PLUGIN_INPUT_SUBCLASS_ID: usize = 1;
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
            // SAFETY: the context is initialized and dropped on the UI controller thread.
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

struct InputTransform {
    x: std::cell::Cell<f64>,
    y: std::cell::Cell<f64>,
    forced_width: std::cell::Cell<u32>,
    forced_height: std::cell::Cell<u32>,
}

impl InputTransform {
    fn new() -> Self {
        Self {
            x: std::cell::Cell::new(1.0),
            y: std::cell::Cell::new(1.0),
            forced_width: std::cell::Cell::new(0),
            forced_height: std::cell::Cell::new(0),
        }
    }
}

pub struct Container {
    hwnd: Hwnd,
    attached_view: Hwnd,
    input_transform: Box<InputTransform>,
}

impl Container {
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
            // SAFETY: all pointers are static UTF-16 data, null, or a live Electron HWND.
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
        Ok(Self {
            hwnd,
            attached_view: std::ptr::null_mut(),
            input_transform: Box::new(InputTransform::new()),
        })
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
            let attached_view = GetWindow(self.hwnd, GW_CHILD);
            if !attached_view.is_null() {
                self.resize_attached_view(attached_view, geometry);
            }
        }
    }

    unsafe fn resize_attached_view(
        &mut self,
        attached_view: Hwnd,
        geometry: NativeContainerGeometry,
    ) {
        let mut rect = Rect::default();
        let has_extent = unsafe {
            // SAFETY: attached_view is the live direct child returned by GetWindow.
            GetClientRect(attached_view, &mut rect) != 0
        };
        let current_width = rect.right.saturating_sub(rect.left).max(1) as u32;
        let current_height = rect.bottom.saturating_sub(rect.top).max(1) as u32;
        let target_width = nonzero_extent(geometry.frame_width);
        let target_height = nonzero_extent(geometry.frame_height);
        if has_extent && current_width == target_width && current_height == target_height {
            return;
        }

        if self.attached_view != attached_view {
            self.attached_view = attached_view;
            self.input_transform.x.set(1.0);
            self.input_transform.y.set(1.0);
            self.input_transform.forced_width.set(0);
            self.input_transform.forced_height.set(0);
        }
        let previous_was_forced = self.input_transform.forced_width.get() == current_width
            && self.input_transform.forced_height.get() == current_height;
        let logical_width = if previous_was_forced {
            f64::from(current_width) * self.input_transform.x.get()
        } else {
            f64::from(current_width)
        };
        let logical_height = if previous_was_forced {
            f64::from(current_height) * self.input_transform.y.get()
        } else {
            f64::from(current_height)
        };
        self.input_transform
            .x
            .set(logical_width / f64::from(target_width));
        self.input_transform
            .y
            .set(logical_height / f64::from(target_height));
        self.input_transform.forced_width.set(target_width);
        self.input_transform.forced_height.set(target_height);

        if !previous_was_forced {
            let transform = std::ptr::from_ref(self.input_transform.as_ref()) as usize;
            unsafe {
                // SAFETY: input_transform has a stable boxed address until the container
                // destroys its child HWND during Drop. Comctl32 removes the subclass on
                // WM_NCDESTROY before that box is released.
                SetWindowSubclass(
                    attached_view,
                    Some(plugin_input_subclass),
                    PLUGIN_INPUT_SUBCLASS_ID,
                    transform,
                );
            }
        }
        unsafe {
            // SAFETY: attached_view is live and target dimensions are clamped non-zero.
            // Some plug-ins accept IPlugView::onSize without resizing their root HWND;
            // filling the container prevents their scaled content remaining top-left.
            SetWindowPos(
                attached_view,
                std::ptr::null_mut(),
                0,
                0,
                target_width as i32,
                target_height as i32,
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

unsafe extern "system" fn plugin_input_subclass(
    hwnd: Hwnd,
    message: u32,
    wparam: usize,
    lparam: isize,
    _subclass_id: usize,
    reference_data: usize,
) -> isize {
    let transform = unsafe {
        // SAFETY: SetWindowSubclass receives the stable boxed InputTransform pointer and
        // invokes this procedure only while the subclassed child HWND is alive.
        &*(reference_data as *const InputTransform)
    };
    let lparam = if message == WM_MOUSEMOVE
        || (WM_LBUTTONDOWN..=WM_MBUTTONDBLCLK).contains(&message)
        || (WM_XBUTTONDOWN..=WM_XBUTTONDBLCLK).contains(&message)
    {
        scale_local_point(lparam, transform)
    } else if matches!(
        message,
        WM_MOUSEWHEEL
            | WM_MOUSEHWHEEL
            | WM_CONTEXTMENU
            | WM_POINTERUPDATE
            | WM_POINTERDOWN
            | WM_POINTERUP
    ) {
        unsafe {
            // SAFETY: hwnd is the live subclassed plug-in root and point conversion only
            // borrows its coordinate system for this message dispatch.
            scale_screen_point(hwnd, lparam, transform)
        }
    } else {
        lparam
    };
    unsafe {
        // SAFETY: forwards the possibly adjusted message through the remaining subclass
        // chain and ultimately to the plug-in's original window procedure.
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}

fn scale_local_point(lparam: isize, transform: &InputTransform) -> isize {
    let x = i16::from_ne_bytes((lparam as u16).to_ne_bytes());
    let y = i16::from_ne_bytes(((lparam as u32 >> 16) as u16).to_ne_bytes());
    point_lparam(
        scale_coordinate(i32::from(x), transform.x.get()),
        scale_coordinate(i32::from(y), transform.y.get()),
    )
}

unsafe fn scale_screen_point(hwnd: Hwnd, lparam: isize, transform: &InputTransform) -> isize {
    if lparam == -1 {
        return lparam;
    }
    let x = i16::from_ne_bytes((lparam as u16).to_ne_bytes());
    let y = i16::from_ne_bytes(((lparam as u32 >> 16) as u16).to_ne_bytes());
    let mut point = Point {
        x: i32::from(x),
        y: i32::from(y),
    };
    // SAFETY: hwnd is the live subclassed plug-in root and point is writable.
    if unsafe { ScreenToClient(hwnd, &mut point) } == 0 {
        return lparam;
    }
    point.x = scale_coordinate(point.x, transform.x.get());
    point.y = scale_coordinate(point.y, transform.y.get());
    // SAFETY: hwnd remains live for the duration of this subclass callback.
    if unsafe { ClientToScreen(hwnd, &mut point) } == 0 {
        return lparam;
    }
    point_lparam(point.x, point.y)
}

fn scale_coordinate(value: i32, scale: f64) -> i32 {
    (f64::from(value) * scale)
        .round()
        .clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i32
}

fn point_lparam(x: i32, y: i32) -> isize {
    let x = x.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16 as u16;
    let y = y.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16 as u16;
    ((u32::from(y) << 16) | u32::from(x)) as isize
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
    fn GetWindow(hwnd: Hwnd, command: u32) -> Hwnd;
    fn GetClientRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
    fn ScreenToClient(hwnd: Hwnd, point: *mut Point) -> i32;
    fn ClientToScreen(hwnd: Hwnd, point: *mut Point) -> i32;
    fn SetFocus(hwnd: Hwnd) -> Hwnd;
    fn DestroyWindow(hwnd: Hwnd) -> i32;
}

#[link(name = "comctl32")]
unsafe extern "system" {
    fn SetWindowSubclass(
        hwnd: Hwnd,
        procedure: Option<
            unsafe extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize,
        >,
        subclass_id: usize,
        reference_data: usize,
    ) -> i32;
    fn DefSubclassProc(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forced_child_scale_maps_mouse_back_to_plugin_coordinates() {
        let transform = InputTransform::new();
        transform.x.set(0.8);
        transform.y.set(0.8);

        assert_eq!(
            scale_local_point(point_lparam(125, 250), &transform),
            point_lparam(100, 200)
        );
    }

    #[test]
    fn mouse_mapping_preserves_signed_client_coordinates() {
        let transform = InputTransform::new();
        transform.x.set(0.5);
        transform.y.set(0.5);

        assert_eq!(
            scale_local_point(point_lparam(-20, -10), &transform),
            point_lparam(-10, -5)
        );
    }
}
