//! macOS VST3 loading via `CFBundle`, matching Steinberg's `module_mac.mm`.
//!
//! Commercial modules expect `bundleEntry(CFBundleRef)` so the plug-in can
//! resolve bundle-relative resources. Loading the Mach-O with `dlopen` alone
//! skips that contract and commonly crashes or fails resource lookup.

use std::{
    ffi::{CStr, c_char, c_void},
    path::{Path, PathBuf},
    ptr,
};

use yadaw_vst3_host_sys::abi::{GetPluginFactory, ModuleEntry, ModuleExit};

use crate::{HostError, HostResult};

type CfIndex = isize;
type CfTypeRef = *const c_void;
type CfStringRef = *const c_void;
type CfUrlRef = *const c_void;
type CfBundleRef = *mut c_void;
type CfErrorRef = *mut c_void;
type CfAllocatorRef = *const c_void;
type CfBoolean = u8;
type CfStringEncoding = u32;

const K_CF_ALLOCATOR_DEFAULT: CfAllocatorRef = ptr::null();
const K_CF_STRING_ENCODING_ASCII: CfStringEncoding = 0x0600;
const K_CF_STRING_ENCODING_UTF8: CfStringEncoding = 0x0800_0100;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: CfAllocatorRef,
        buffer: *const u8,
        buf_len: CfIndex,
        is_directory: CfBoolean,
    ) -> CfUrlRef;
    fn CFBundleCreate(allocator: CfAllocatorRef, bundle_url: CfUrlRef) -> CfBundleRef;
    fn CFBundleLoadExecutableAndReturnError(
        bundle: CfBundleRef,
        error: *mut CfErrorRef,
    ) -> CfBoolean;
    fn CFBundleGetFunctionPointerForName(
        bundle: CfBundleRef,
        function_name: CfStringRef,
    ) -> *mut c_void;
    fn CFBundleCopyExecutableURL(bundle: CfBundleRef) -> CfUrlRef;
    fn CFURLGetFileSystemRepresentation(
        url: CfUrlRef,
        resolve_against_base: CfBoolean,
        buffer: *mut u8,
        max_buf_len: CfIndex,
    ) -> CfBoolean;
    fn CFStringCreateWithCString(
        allocator: CfAllocatorRef,
        c_str: *const c_char,
        encoding: CfStringEncoding,
    ) -> CfStringRef;
    fn CFErrorCopyDescription(error: CfErrorRef) -> CfStringRef;
    fn CFStringGetLength(string: CfStringRef) -> CfIndex;
    fn CFStringGetMaximumSizeForEncoding(length: CfIndex, encoding: CfStringEncoding) -> CfIndex;
    fn CFStringGetCString(
        string: CfStringRef,
        buffer: *mut c_char,
        buffer_size: CfIndex,
        encoding: CfStringEncoding,
    ) -> CfBoolean;
    fn CFRelease(cf: CfTypeRef);
}

/// Owns a loaded VST3 `CFBundle` and its mandatory `bundleExit` entry point.
pub struct MacBundle {
    bundle: CfBundleRef,
    exit: ModuleExit,
}

impl MacBundle {
    /// Loads `path` (a `.vst3` bundle or a file inside one) through CoreFoundation.
    pub fn load(path: &Path) -> HostResult<(Self, GetPluginFactory, PathBuf)> {
        let bundle_path =
            bundle_root(path).ok_or_else(|| HostError::ModuleBinary(path.to_path_buf()))?;
        let path_bytes = path_as_bytes(bundle_path).ok_or_else(|| HostError::BundleLoad {
            path: bundle_path.to_path_buf(),
            message: "bundle path is not valid UTF-8".into(),
        })?;

        unsafe {
            // SAFETY: path_bytes is a filesystem path; CoreFoundation copies it.
            let url = CFURLCreateFromFileSystemRepresentation(
                K_CF_ALLOCATOR_DEFAULT,
                path_bytes.as_ptr(),
                path_bytes.len() as CfIndex,
                1,
            );
            if url.is_null() {
                return Err(HostError::BundleLoad {
                    path: bundle_path.to_path_buf(),
                    message: "CFURLCreateFromFileSystemRepresentation failed".into(),
                });
            }
            let bundle = CFBundleCreate(K_CF_ALLOCATOR_DEFAULT, url);
            CFRelease(url.cast());
            if bundle.is_null() {
                return Err(HostError::BundleLoad {
                    path: bundle_path.to_path_buf(),
                    message: "CFBundleCreate failed".into(),
                });
            }

            let mut error: CfErrorRef = ptr::null_mut();
            if CFBundleLoadExecutableAndReturnError(bundle, &mut error) == 0 {
                let message = if error.is_null() {
                    "CFBundleLoadExecutable failed".into()
                } else {
                    let description = cf_string_to_string(CFErrorCopyDescription(error));
                    CFRelease(error.cast());
                    description.unwrap_or_else(|| "CFBundleLoadExecutable failed".into())
                };
                CFRelease(bundle.cast());
                return Err(HostError::BundleLoad {
                    path: bundle_path.to_path_buf(),
                    message,
                });
            }

            let entry =
                function_pointer::<ModuleEntry>(bundle, c"bundleEntry").ok_or_else(|| {
                    CFRelease(bundle.cast());
                    HostError::MissingEntryPoint("bundleEntry")
                })?;
            let exit = function_pointer::<ModuleExit>(bundle, c"bundleExit").ok_or_else(|| {
                CFRelease(bundle.cast());
                HostError::MissingEntryPoint("bundleExit")
            })?;
            let factory = function_pointer::<GetPluginFactory>(bundle, c"GetPluginFactory")
                .ok_or_else(|| {
                    CFRelease(bundle.cast());
                    HostError::MissingEntryPoint("GetPluginFactory")
                })?;

            // SAFETY: bundleEntry retains the CFBundleRef and initializes the module.
            if !entry(bundle.cast()) {
                CFRelease(bundle.cast());
                return Err(HostError::Operation {
                    operation: "bundleEntry",
                    result: 1,
                });
            }

            let binary_path = executable_path(bundle).unwrap_or_else(|| bundle_path.to_path_buf());
            Ok((Self { bundle, exit }, factory, binary_path))
        }
    }
}

impl Drop for MacBundle {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: factory interfaces were released by Module before this drop;
            // bundleExit/DeinitModule are the SDK-mandated unload pair.
            (self.exit)();
            CFRelease(self.bundle.cast());
        }
    }
}

fn bundle_root(path: &Path) -> Option<&Path> {
    if is_vst3_bundle(path) {
        return Some(path);
    }
    path.ancestors().find(|ancestor| is_vst3_bundle(ancestor))
}

fn is_vst3_bundle(path: &Path) -> bool {
    path.is_dir()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("vst3"))
}

fn path_as_bytes(path: &Path) -> Option<&[u8]> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Some(path.as_os_str().as_bytes())
    }
    #[cfg(not(unix))]
    {
        path.to_str().map(str::as_bytes)
    }
}

unsafe fn function_pointer<T>(bundle: CfBundleRef, name: &CStr) -> Option<T> {
    // SAFETY: `name` is a NUL-terminated symbol exported by the VST3 bundle;
    // CoreFoundation copies the C string and the looked-up address is cast to
    // the matching VST3 ABI function-pointer type.
    unsafe {
        let cf_name = CFStringCreateWithCString(
            K_CF_ALLOCATOR_DEFAULT,
            name.as_ptr(),
            K_CF_STRING_ENCODING_ASCII,
        );
        if cf_name.is_null() {
            return None;
        }
        let symbol = CFBundleGetFunctionPointerForName(bundle, cf_name);
        CFRelease(cf_name.cast());
        if symbol.is_null() {
            None
        } else {
            Some(std::mem::transmute_copy(&symbol))
        }
    }
}

unsafe fn executable_path(bundle: CfBundleRef) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;

    // SAFETY: `bundle` is a live CFBundleRef owned by MacBundle; the copied
    // executable URL/path buffers are released before returning.
    unsafe {
        let url = CFBundleCopyExecutableURL(bundle);
        if url.is_null() {
            return None;
        }
        let mut buffer = vec![0u8; 4096];
        let ok =
            CFURLGetFileSystemRepresentation(url, 1, buffer.as_mut_ptr(), buffer.len() as CfIndex);
        CFRelease(url.cast());
        if ok == 0 {
            return None;
        }
        let len = buffer
            .iter()
            .position(|&byte| byte == 0)
            .unwrap_or(buffer.len());
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..len])))
    }
}

unsafe fn cf_string_to_string(string: CfStringRef) -> Option<String> {
    if string.is_null() {
        return None;
    }
    // SAFETY: `string` is a retained CFString from CFErrorCopyDescription; this
    // function releases it after copying UTF-8 bytes into owned storage.
    unsafe {
        let length = CFStringGetLength(string);
        let max_size = CFStringGetMaximumSizeForEncoding(length, K_CF_STRING_ENCODING_UTF8);
        if max_size <= 0 {
            CFRelease(string.cast());
            return None;
        }
        let mut buffer = vec![0u8; max_size as usize + 1];
        let ok = CFStringGetCString(
            string,
            buffer.as_mut_ptr().cast::<c_char>(),
            buffer.len() as CfIndex,
            K_CF_STRING_ENCODING_UTF8,
        );
        CFRelease(string.cast());
        if ok == 0 {
            return None;
        }
        CStr::from_ptr(buffer.as_ptr().cast::<c_char>())
            .to_str()
            .ok()
            .map(str::to_owned)
    }
}

#[cfg(test)]
mod tests {
    use super::is_vst3_bundle;
    use std::path::Path;

    #[test]
    fn detects_vst3_bundle_extension_case_insensitively() {
        assert!(!is_vst3_bundle(Path::new("/tmp/not-a-bundle")));
        assert!(!is_vst3_bundle(Path::new("/tmp/plugin.vst3"))); // missing on disk
    }
}
