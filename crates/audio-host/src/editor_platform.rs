use std::{
    ffi::{CStr, c_void},
    num::{NonZeroU32, NonZeroUsize},
};

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

/// A native child owned by an Electron editor window. The VST3 view is attached
/// below the sandboxed web toolbar without giving the plug-in ownership of the
/// host window.
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
#[path = "editor_platform/windows.rs"]
mod platform;

#[cfg(target_os = "macos")]
#[path = "editor_platform/macos.rs"]
mod platform;

#[cfg(target_os = "linux")]
#[path = "editor_platform/linux.rs"]
mod platform;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
#[path = "editor_platform/unsupported.rs"]
mod platform;
