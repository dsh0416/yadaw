//! CLAP module loading and factory discovery.

use std::{
    ffi::{CStr, CString, c_char},
    marker::PhantomData,
    path::{Path, PathBuf},
    ptr::NonNull,
    rc::Rc,
};

use clap_sys::{
    entry::clap_plugin_entry,
    factory::plugin_factory::{CLAP_PLUGIN_FACTORY_ID, clap_plugin_factory},
    host::clap_host,
    plugin::{clap_plugin, clap_plugin_descriptor},
    version::clap_version_is_compatible,
};
use libloading::Library;

const ENTRY_SYMBOL: &[u8] = b"clap_entry\0";
const MAX_FEATURES: usize = 256;

/// Immutable metadata returned without creating a plug-in instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClapDescriptor {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub description: String,
    pub features: Vec<String>,
}

/// Failure while loading or enumerating a CLAP artifact.
#[derive(Debug, thiserror::Error)]
pub enum ClapModuleError {
    #[error("could not load CLAP module `{path}`: {source}")]
    Load {
        path: PathBuf,
        #[source]
        source: libloading::Error,
    },
    #[error("CLAP artifact path contains a NUL byte")]
    InvalidPath,
    #[error("CLAP entry symbol is null")]
    NullEntry,
    #[error("CLAP entry version is incompatible")]
    IncompatibleVersion,
    #[error("CLAP entry is missing `{0}`")]
    MissingEntryFunction(&'static str),
    #[error("CLAP module initialization failed")]
    InitializationFailed,
    #[error("CLAP module did not expose the plug-in factory")]
    MissingPluginFactory,
    #[error("CLAP plug-in factory is missing `{0}`")]
    MissingFactoryFunction(&'static str),
    #[error("CLAP descriptor {index} is null")]
    NullDescriptor { index: u32 },
    #[error("CLAP factory returned a null plug-in instance")]
    NullPlugin,
    #[error("CLAP descriptor field `{field}` is null")]
    NullString { field: &'static str },
    #[error("CLAP descriptor field `{field}` is not valid UTF-8")]
    InvalidUtf8 { field: &'static str },
    #[error("CLAP descriptor has more than {MAX_FEATURES} features or is not terminated")]
    UnterminatedFeatures,
}

/// Main-thread CLAP entry and factory owner.
///
/// This type is intentionally neither `Send` nor `Sync`; CLAP requires module
/// initialization, factory access, and teardown on the host main thread.
pub struct ClapModule {
    entry: NonNull<clap_plugin_entry>,
    factory: NonNull<clap_plugin_factory>,
    _library: Library,
    _main_thread_only: PhantomData<Rc<()>>,
}

impl ClapModule {
    /// Loads and initializes a CLAP artifact and validates its core factory.
    pub fn open(artifact_path: &Path) -> Result<Self, ClapModuleError> {
        let module_path = resolve_module_path(artifact_path);
        // SAFETY: The library is retained by `ClapModule` until after CLAP
        // deinitialization, and no symbols escape the owning value.
        let library =
            unsafe { Library::new(&module_path) }.map_err(|source| ClapModuleError::Load {
                path: module_path.clone(),
                source,
            })?;
        // SAFETY: `clap_entry` is the ABI-mandated exported static. Its pointer
        // is checked before dereferencing and remains valid while `library` lives.
        let entry = unsafe {
            let symbol = library
                .get::<*const clap_plugin_entry>(ENTRY_SYMBOL)
                .map_err(|source| ClapModuleError::Load {
                    path: module_path.clone(),
                    source,
                })?;
            NonNull::new((*symbol).cast_mut()).ok_or(ClapModuleError::NullEntry)?
        };
        // SAFETY: `entry` points into the retained dynamic library.
        let entry_ref = unsafe { entry.as_ref() };
        if !clap_version_is_compatible(entry_ref.clap_version) {
            return Err(ClapModuleError::IncompatibleVersion);
        }
        let init = entry_ref
            .init
            .ok_or(ClapModuleError::MissingEntryFunction("init"))?;
        let plugin_path = CString::new(artifact_path.to_string_lossy().as_bytes())
            .map_err(|_| ClapModuleError::InvalidPath)?;
        // SAFETY: The path is NUL-terminated for the duration of the call and
        // the entry pointer belongs to the retained library.
        if !unsafe { init(plugin_path.as_ptr()) } {
            return Err(ClapModuleError::InitializationFailed);
        }

        let factory = match factory(entry) {
            Ok(factory) => factory,
            Err(error) => {
                deinitialize(entry);
                return Err(error);
            }
        };
        Ok(Self {
            entry,
            factory,
            _library: library,
            _main_thread_only: PhantomData,
        })
    }

    /// Enumerates descriptors without instantiating plug-ins.
    pub fn descriptors(&self) -> Result<Vec<ClapDescriptor>, ClapModuleError> {
        // SAFETY: The factory belongs to the initialized, retained module.
        let factory = unsafe { self.factory.as_ref() };
        let count = factory
            .get_plugin_count
            .ok_or(ClapModuleError::MissingFactoryFunction("get_plugin_count"))?;
        let descriptor =
            factory
                .get_plugin_descriptor
                .ok_or(ClapModuleError::MissingFactoryFunction(
                    "get_plugin_descriptor",
                ))?;
        // SAFETY: The factory pointer is valid for the initialized module.
        let count = unsafe { count(self.factory.as_ptr()) };
        (0..count)
            .map(|index| {
                // SAFETY: The factory owns descriptor storage and `index` is
                // bounded by the count reported by the same factory.
                let raw = unsafe { descriptor(self.factory.as_ptr(), index) };
                let raw = NonNull::new(raw.cast_mut())
                    .ok_or(ClapModuleError::NullDescriptor { index })?;
                // SAFETY: The pointer was checked and remains module-owned.
                unsafe { decode_descriptor(raw.as_ref()) }
            })
            .collect()
    }

    pub(crate) fn create_plugin(
        &self,
        host: *const clap_host,
        plugin_id: *const c_char,
    ) -> Result<NonNull<clap_plugin>, ClapModuleError> {
        // SAFETY: The factory belongs to this initialized module.
        let create = unsafe { self.factory.as_ref() }
            .create_plugin
            .ok_or(ClapModuleError::MissingFactoryFunction("create_plugin"))?;
        // SAFETY: The caller retains the host and plug-in ID for this call. The
        // returned pointer is checked and remains owned by the module instance.
        let plugin = unsafe { create(self.factory.as_ptr(), host, plugin_id) };
        NonNull::new(plugin.cast_mut()).ok_or(ClapModuleError::NullPlugin)
    }
}

impl Drop for ClapModule {
    fn drop(&mut self) {
        deinitialize(self.entry);
    }
}

fn factory(
    entry: NonNull<clap_plugin_entry>,
) -> Result<NonNull<clap_plugin_factory>, ClapModuleError> {
    // SAFETY: `entry` is checked and owned by an initialized module.
    let get_factory = unsafe { entry.as_ref() }
        .get_factory
        .ok_or(ClapModuleError::MissingEntryFunction("get_factory"))?;
    // SAFETY: The factory identifier is a static NUL-terminated C string.
    let factory = unsafe { get_factory(CLAP_PLUGIN_FACTORY_ID.as_ptr()) };
    NonNull::new(factory.cast::<clap_plugin_factory>().cast_mut())
        .ok_or(ClapModuleError::MissingPluginFactory)
}

fn deinitialize(entry: NonNull<clap_plugin_entry>) {
    // SAFETY: The entry belongs to a still-loaded library. `deinit` is called
    // exactly once for every successful `init` path.
    if let Some(deinit) = unsafe { entry.as_ref() }.deinit {
        // SAFETY: CLAP permits this call after all factory-owned objects drop.
        unsafe { deinit() };
    }
}

unsafe fn decode_descriptor(
    descriptor: &clap_plugin_descriptor,
) -> Result<ClapDescriptor, ClapModuleError> {
    Ok(ClapDescriptor {
        // SAFETY: Descriptor strings are module-owned and required to remain
        // valid for the module lifetime; each pointer and UTF-8 result is checked.
        id: unsafe { required_string(descriptor.id, "id") }?,
        // SAFETY: Same descriptor string lifetime contract as above.
        name: unsafe { required_string(descriptor.name, "name") }?,
        // SAFETY: Same descriptor string lifetime contract as above.
        vendor: unsafe { optional_string(descriptor.vendor, "vendor") }?,
        // SAFETY: Same descriptor string lifetime contract as above.
        version: unsafe { optional_string(descriptor.version, "version") }?,
        // SAFETY: Same descriptor string lifetime contract as above.
        description: unsafe { optional_string(descriptor.description, "description") }?,
        // SAFETY: CLAP specifies a null-terminated feature pointer array. The
        // scan is additionally capped to avoid unbounded work on malformed data.
        features: unsafe { features(descriptor.features) }?,
    })
}

unsafe fn required_string(
    value: *const c_char,
    field: &'static str,
) -> Result<String, ClapModuleError> {
    if value.is_null() {
        return Err(ClapModuleError::NullString { field });
    }
    // SAFETY: Caller guarantees a module-owned NUL-terminated descriptor field.
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(str::to_owned)
        .map_err(|_| ClapModuleError::InvalidUtf8 { field })
}

unsafe fn optional_string(
    value: *const c_char,
    field: &'static str,
) -> Result<String, ClapModuleError> {
    if value.is_null() {
        return Ok(String::new());
    }
    // SAFETY: Caller guarantees a module-owned NUL-terminated descriptor field.
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(str::to_owned)
        .map_err(|_| ClapModuleError::InvalidUtf8 { field })
}

unsafe fn features(mut values: *const *const c_char) -> Result<Vec<String>, ClapModuleError> {
    if values.is_null() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for _ in 0..MAX_FEATURES {
        // SAFETY: Caller guarantees a CLAP descriptor feature array; scanning
        // stops at the first null element and is capped by `MAX_FEATURES`.
        let value = unsafe { *values };
        if value.is_null() {
            return Ok(result);
        }
        // SAFETY: Non-null feature entries are NUL-terminated module strings.
        result.push(unsafe { required_string(value, "features") }?);
        // SAFETY: Advancing within the descriptor-owned pointer array is valid
        // until its required null terminator, with a defensive hard cap.
        values = unsafe { values.add(1) };
    }
    Err(ClapModuleError::UnterminatedFeatures)
}

fn resolve_module_path(artifact_path: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if artifact_path.is_dir() {
            let name = artifact_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            return artifact_path
                .join("Contents")
                .join("MacOS")
                .join(name.as_ref());
        }
    }
    artifact_path.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap_sys::version::CLAP_VERSION;

    fn descriptor(
        id: *const c_char,
        name: *const c_char,
        vendor: *const c_char,
        version: *const c_char,
        description: *const c_char,
        features: *const *const c_char,
    ) -> clap_plugin_descriptor {
        clap_plugin_descriptor {
            clap_version: CLAP_VERSION,
            id,
            name,
            vendor,
            url: std::ptr::null(),
            manual_url: std::ptr::null(),
            support_url: std::ptr::null(),
            version,
            description,
            features,
        }
    }

    #[test]
    fn descriptor_decoding_copies_required_optional_and_feature_strings() {
        let id = CString::new("com.heron.test").unwrap();
        let name = CString::new("Test Instrument").unwrap();
        let vendor = CString::new("Heron").unwrap();
        let version = CString::new("1.2.3").unwrap();
        let instrument = CString::new("instrument").unwrap();
        let stereo = CString::new("stereo").unwrap();
        let feature_pointers = [instrument.as_ptr(), stereo.as_ptr(), std::ptr::null()];
        let raw = descriptor(
            id.as_ptr(),
            name.as_ptr(),
            vendor.as_ptr(),
            version.as_ptr(),
            std::ptr::null(),
            feature_pointers.as_ptr(),
        );

        // SAFETY: Every descriptor pointer refers to live, NUL-terminated test storage.
        let decoded = unsafe { decode_descriptor(&raw) }.unwrap();
        assert_eq!(
            decoded,
            ClapDescriptor {
                id: "com.heron.test".into(),
                name: "Test Instrument".into(),
                vendor: "Heron".into(),
                version: "1.2.3".into(),
                description: String::new(),
                features: vec!["instrument".into(), "stereo".into()],
            }
        );
    }

    #[test]
    fn string_decoding_reports_null_and_invalid_utf8_fields() {
        let valid = CString::new("valid").unwrap();
        let invalid = [0xff_u8 as c_char, 0];

        // SAFETY: Test pointers are either deliberately null or valid through each call.
        unsafe {
            assert!(matches!(
                required_string(std::ptr::null(), "id"),
                Err(ClapModuleError::NullString { field: "id" })
            ));
            assert_eq!(optional_string(std::ptr::null(), "vendor").unwrap(), "");
            assert_eq!(required_string(valid.as_ptr(), "id").unwrap(), "valid");
            assert_eq!(optional_string(valid.as_ptr(), "vendor").unwrap(), "valid");
            assert!(matches!(
                required_string(invalid.as_ptr(), "id"),
                Err(ClapModuleError::InvalidUtf8 { field: "id" })
            ));
            assert!(matches!(
                optional_string(invalid.as_ptr(), "vendor"),
                Err(ClapModuleError::InvalidUtf8 { field: "vendor" })
            ));
        }
    }

    #[test]
    fn descriptor_decoding_preserves_the_failing_required_field() {
        let valid = CString::new("valid").unwrap();
        let raw = descriptor(
            valid.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        );

        // SAFETY: The ID is valid and the deliberately null name exercises validation.
        let decoded = unsafe { decode_descriptor(&raw) };
        assert!(matches!(
            decoded,
            Err(ClapModuleError::NullString { field: "name" })
        ));
    }

    #[test]
    fn feature_arrays_accept_absence_and_require_a_bounded_terminator() {
        let feature = CString::new("audio-effect").unwrap();
        let terminated = [feature.as_ptr(), std::ptr::null()];
        let unterminated = vec![feature.as_ptr(); MAX_FEATURES];
        let invalid = [0xff_u8 as c_char, 0];
        let invalid_features = [invalid.as_ptr(), std::ptr::null()];

        // SAFETY: Arrays remain live and contain the documented pointers for each call.
        unsafe {
            assert!(features(std::ptr::null()).unwrap().is_empty());
            assert_eq!(features(terminated.as_ptr()).unwrap(), ["audio-effect"]);
            assert!(matches!(
                features(unterminated.as_ptr()),
                Err(ClapModuleError::UnterminatedFeatures)
            ));
            assert!(matches!(
                features(invalid_features.as_ptr()),
                Err(ClapModuleError::InvalidUtf8 { field: "features" })
            ));
        }
    }

    #[test]
    fn module_path_is_unchanged_on_non_bundle_platforms() {
        let path = Path::new("/plugins/Heron Test.clap");
        assert_eq!(resolve_module_path(path), path);
    }
}
