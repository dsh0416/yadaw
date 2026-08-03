use std::{
    ffi::{c_char, c_void},
    sync::OnceLock,
};

const DPI_HOSTING_BEHAVIOR_INVALID: i32 = -1;
const DPI_HOSTING_BEHAVIOR_MIXED: i32 = 1;
const DPI_AWARENESS_CONTEXT_UNAWARE_GDISCALED: *mut c_void = (-5_isize) as *mut c_void;

type SetThreadDpiHostingBehavior = unsafe extern "system" fn(value: i32) -> i32;
type SetThreadDpiAwarenessContext = unsafe extern "system" fn(value: *mut c_void) -> *mut c_void;

struct DpiFunctions {
    set_hosting_behavior: SetThreadDpiHostingBehavior,
    set_awareness_context: SetThreadDpiAwarenessContext,
}

fn dpi_functions() -> Option<&'static DpiFunctions> {
    static FUNCTIONS: OnceLock<Option<DpiFunctions>> = OnceLock::new();
    FUNCTIONS
        .get_or_init(|| unsafe {
            // SAFETY: user32 is loaded by every process with HWNDs. The resolved symbols
            // are checked non-null before casting to their documented Win32 signatures.
            let user32 = GetModuleHandleA(c"user32.dll".as_ptr());
            if user32.is_null() {
                return None;
            }
            let hosting = GetProcAddress(user32, c"SetThreadDpiHostingBehavior".as_ptr());
            let awareness = GetProcAddress(user32, c"SetThreadDpiAwarenessContext".as_ptr());
            if hosting.is_null() || awareness.is_null() {
                return None;
            }
            Some(DpiFunctions {
                // SAFETY: GetProcAddress returned the named User32 procedures and Win32
                // function pointers have the same representation as the raw addresses.
                set_hosting_behavior: std::mem::transmute::<
                    *mut c_void,
                    SetThreadDpiHostingBehavior,
                >(hosting),
                set_awareness_context: std::mem::transmute::<
                    *mut c_void,
                    SetThreadDpiAwarenessContext,
                >(awareness),
            })
        })
        .as_ref()
}

pub struct EditorWindowContext {
    functions: Option<&'static DpiFunctions>,
    previous: Option<i32>,
}

impl EditorWindowContext {
    pub fn begin() -> Self {
        let functions = dpi_functions();
        let previous = functions.map_or(DPI_HOSTING_BEHAVIOR_INVALID, |functions| unsafe {
            // SAFETY: changes only the current UI thread and is restored by Drop.
            (functions.set_hosting_behavior)(DPI_HOSTING_BEHAVIOR_MIXED)
        });
        Self {
            functions,
            previous: (previous != DPI_HOSTING_BEHAVIOR_INVALID).then_some(previous),
        }
    }

    pub fn supports_platform_scale_fallback(&self) -> bool {
        self.previous.is_some()
    }
}

impl Drop for EditorWindowContext {
    fn drop(&mut self) {
        if let (Some(functions), Some(previous)) = (self.functions, self.previous) {
            unsafe {
                // SAFETY: restores the hosting behavior saved on this same UI thread.
                (functions.set_hosting_behavior)(previous);
            }
        }
    }
}

struct ChildScaleContext {
    functions: &'static DpiFunctions,
    previous_awareness: *mut c_void,
    previous_hosting: i32,
}

impl ChildScaleContext {
    fn begin() -> Option<Self> {
        let functions = dpi_functions()?;
        let previous_hosting = unsafe {
            // SAFETY: changes only the current UI thread and is restored by Drop.
            (functions.set_hosting_behavior)(DPI_HOSTING_BEHAVIOR_MIXED)
        };
        if previous_hosting == DPI_HOSTING_BEHAVIOR_INVALID {
            return None;
        }
        let previous_awareness = unsafe {
            // SAFETY: changes only the current UI thread and is restored by Drop.
            (functions.set_awareness_context)(DPI_AWARENESS_CONTEXT_UNAWARE_GDISCALED)
        };
        if previous_awareness.is_null() {
            unsafe {
                // SAFETY: balances the successful hosting-behavior change above.
                (functions.set_hosting_behavior)(previous_hosting);
            }
            return None;
        }
        Some(Self {
            functions,
            previous_awareness,
            previous_hosting,
        })
    }
}

impl Drop for ChildScaleContext {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: restores both values captured on this same UI thread.
            (self.functions.set_awareness_context)(self.previous_awareness);
            (self.functions.set_hosting_behavior)(self.previous_hosting);
        }
    }
}

pub fn with_native_child_scale_context<T>(
    platform_scaled: bool,
    operation: impl FnOnce() -> T,
) -> T {
    let _context = platform_scaled.then(ChildScaleContext::begin).flatten();
    operation()
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleA(module_name: *const c_char) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, procedure_name: *const c_char) -> *mut c_void;
}
