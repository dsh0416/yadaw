use super::{CStr, NativeContainerGeometry, NativeParentHandle, c_void};

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
