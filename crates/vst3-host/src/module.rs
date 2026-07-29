use std::{
    ffi::c_void,
    path::{Path, PathBuf},
};

use yadaw_vst3_host_sys::{
    Steinberg::{IPluginFactory, IPluginFactory2, PClassInfo, PClassInfo2},
    YadawAraFactoryInfo,
    abi::{PluginFactory2VTable, PluginFactoryVTable},
    yadaw_ara_query_factory,
};

use crate::{ClassId, ComInterface, ComPtr, HostError, HostResult, id::fixed_c_string};

#[cfg(target_os = "macos")]
#[path = "module_macos.rs"]
mod module_macos;
#[cfg(target_os = "macos")]
use module_macos::MacBundle;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AraFactoryInfo {
    pub factory_id: String,
    pub document_archive_id: String,
    pub plugin_name: String,
    pub manufacturer_name: String,
    pub version: String,
    pub lowest_api_generation: i32,
    pub highest_api_generation: i32,
    pub playback_transformation_flags: u32,
    pub supports_storing_audio_file_chunks: bool,
}

#[cfg(not(target_os = "macos"))]
mod dynamic {
    use std::{
        ffi::OsStr,
        path::{Path, PathBuf},
    };

    use libloading::Library;
    #[cfg(target_os = "linux")]
    use yadaw_vst3_host_sys::abi::ModuleEntry;
    use yadaw_vst3_host_sys::abi::{GetPluginFactory, ModuleExit};

    use super::Module;
    use crate::{ComPtr, HostError, HostResult};

    pub(super) fn open(path: &Path) -> HostResult<Module> {
        let binary_path = resolve_module_binary(path)
            .ok_or_else(|| HostError::ModuleBinary(path.to_path_buf()))?;
        let library = unsafe {
            // SAFETY: Library remains owned by Module until after all factory
            // references are released.
            Library::new(&binary_path)
        }
        .map_err(|source| HostError::ModuleOpen {
            path: binary_path.clone(),
            source,
        })?;

        #[cfg(target_os = "windows")]
        let (library, exit, factory_fn) = {
            // SAFETY: InitDll/ExitDll/GetPluginFactory have the VST3 ABI
            // signatures and remain valid while Library is owned.
            unsafe {
                if let Ok(init) = library.get::<unsafe extern "system" fn() -> bool>(b"InitDll\0")
                    && !init()
                {
                    return Err(HostError::Operation {
                        operation: "InitDll",
                        result: 1,
                    });
                }
                let exit = library
                    .get::<ModuleExit>(b"ExitDll\0")
                    .ok()
                    .map(|symbol| *symbol);
                let factory_fn: GetPluginFactory = *library
                    .get(b"GetPluginFactory\0")
                    .map_err(|_| HostError::MissingEntryPoint("GetPluginFactory"))?;
                (library, exit, factory_fn)
            }
        };

        #[cfg(target_os = "linux")]
        let (library, exit, factory_fn) = {
            // SAFETY: ModuleEntry/ModuleExit/GetPluginFactory have the VST3 ABI
            // signatures; ModuleEntry receives the live dlopen handle.
            unsafe {
                let entry: ModuleEntry = *library
                    .get(b"ModuleEntry\0")
                    .map_err(|_| HostError::MissingEntryPoint("ModuleEntry"))?;
                let exit: ModuleExit = *library
                    .get(b"ModuleExit\0")
                    .map_err(|_| HostError::MissingEntryPoint("ModuleExit"))?;
                let factory_fn: GetPluginFactory = *library
                    .get(b"GetPluginFactory\0")
                    .map_err(|_| HostError::MissingEntryPoint("GetPluginFactory"))?;
                let unix = libloading::os::unix::Library::from(library);
                let handle = unix.into_raw();
                let library = Library::from(libloading::os::unix::Library::from_raw(handle));
                if !entry(handle) {
                    return Err(HostError::Operation {
                        operation: "ModuleEntry",
                        result: 1,
                    });
                }
                (library, Some(exit), factory_fn)
            }
        };

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        compile_error!("VST3 dynamic module loading requires Windows or Linux");

        let factory = unsafe {
            // SAFETY: GetPluginFactory returns an owned factory on success.
            ComPtr::from_raw(factory_fn(), "GetPluginFactory")?
        };
        Ok(Module {
            factory: Some(factory),
            library,
            binary_path,
            exit,
        })
    }

    fn resolve_module_binary(path: &Path) -> Option<PathBuf> {
        if path.is_file() {
            return Some(path.to_path_buf());
        }
        let stem = path.file_stem().and_then(OsStr::to_str)?;
        #[cfg(target_os = "windows")]
        let candidates = [
            path.join("Contents")
                .join("x86_64-win")
                .join(format!("{stem}.vst3")),
            path.join("Contents")
                .join("x86_64-win")
                .join(format!("{stem}.dll")),
        ];
        #[cfg(target_os = "linux")]
        let candidates = [
            path.join("Contents")
                .join("x86_64-linux")
                .join(format!("{stem}.so")),
            path.join("Contents")
                .join("aarch64-linux")
                .join(format!("{stem}.so")),
        ];
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        let candidates: [PathBuf; 0] = [];
        candidates.into_iter().find(|candidate| candidate.is_file())
    }
}

/// Stable metadata exposed by the base VST3 factory interface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassInfo {
    pub id: ClassId,
    pub category: String,
    pub name: String,
    /// Pipe-separated VST3 subcategories from `IPluginFactory2`, when available.
    pub subcategories: String,
}

/// A loaded VST3 module and its root factory.
///
/// Field order is intentional: the factory is released before the dynamic
/// library / bundle is unloaded.
pub struct Module {
    factory: Option<ComPtr<IPluginFactory>>,
    #[cfg(target_os = "macos")]
    mac_bundle: Option<MacBundle>,
    #[cfg(not(target_os = "macos"))]
    library: libloading::Library,
    binary_path: PathBuf,
    #[cfg(not(target_os = "macos"))]
    exit: Option<yadaw_vst3_host_sys::abi::ModuleExit>,
}

impl Module {
    /// Loads a VST3 bundle or direct module binary.
    pub fn open(path: impl AsRef<Path>) -> HostResult<Self> {
        let path = path.as_ref();
        #[cfg(target_os = "macos")]
        {
            let (mac_bundle, factory_fn, binary_path) = MacBundle::load(path)?;
            let factory = unsafe {
                // SAFETY: GetPluginFactory is the VST3 ABI entry point and returns
                // an owned factory reference on success.
                ComPtr::from_raw(factory_fn(), "GetPluginFactory")?
            };
            Ok(Self {
                factory: Some(factory),
                mac_bundle: Some(mac_bundle),
                binary_path,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            dynamic::open(path)
        }
    }

    #[must_use]
    pub fn binary_path(&self) -> &Path {
        &self.binary_path
    }

    #[must_use]
    pub fn factory(&self) -> &ComPtr<IPluginFactory> {
        self.factory
            .as_ref()
            .expect("factory is present until module drop")
    }

    pub fn create_ara_main_factory(&self, class_id: ClassId) -> HostResult<crate::AraMainFactory> {
        crate::AraMainFactory::create(self.factory().as_ptr(), class_id)
    }

    /// Creates one SDK interface for a class exposed by this module.
    pub fn create<I: ComInterface>(&self, class_id: ClassId) -> HostResult<ComPtr<I>> {
        let factory = self.factory().as_ptr();
        let table = unsafe {
            // SAFETY: factory is live and begins with PluginFactoryVTable.
            *factory.cast::<*const PluginFactoryVTable>()
        };
        let class_id = class_id.to_tuid();
        let mut output = std::ptr::null_mut::<c_void>();
        let result = unsafe {
            // SAFETY: IDs are target ABI TUIDs and output is writable storage
            // for the owned interface reference returned by the factory.
            ((*table).create_instance)(
                factory,
                class_id.as_ptr(),
                I::IID.as_ptr(),
                std::ptr::addr_of_mut!(output),
            )
        };
        if result != 0 {
            return Err(HostError::Operation {
                operation: "createInstance",
                result,
            });
        }
        unsafe {
            // SAFETY: successful createInstance returns one owned I reference.
            ComPtr::from_raw(output.cast::<I>(), "createInstance")
        }
    }

    /// Enumerates classes without constructing plug-in instances.
    pub fn classes(&self) -> HostResult<Vec<ClassInfo>> {
        let factory = self.factory().as_ptr();
        let table = unsafe {
            // SAFETY: factory is live for this Module and begins with the
            // IPluginFactory vtable pointer.
            *factory.cast::<*const PluginFactoryVTable>()
        };
        let factory2 = self.factory().query::<IPluginFactory2>().ok();
        let count = unsafe {
            // SAFETY: table belongs to factory.
            ((*table).count_classes)(factory)
        }
        .max(0);
        let mut classes = Vec::with_capacity(count as usize);
        for index in 0..count {
            let mut raw = std::mem::MaybeUninit::<PClassInfo>::zeroed();
            let result = unsafe {
                // SAFETY: raw points to writable SDK storage and index is
                // within countClasses().
                ((*table).get_class_info)(factory, index, raw.as_mut_ptr())
            };
            if result != 0 {
                return Err(HostError::Operation {
                    operation: "getClassInfo",
                    result,
                });
            }
            let raw = unsafe {
                // SAFETY: successful getClassInfo initialized the structure.
                raw.assume_init()
            };
            let subcategories = factory2
                .as_ref()
                .and_then(|factory2| class_subcategories(factory2, index))
                .unwrap_or_default();
            classes.push(ClassInfo {
                id: ClassId::from_tuid(raw.cid),
                category: fixed_c_string(&raw.category),
                name: fixed_c_string(&raw.name),
                subcategories,
            });
        }
        Ok(classes)
    }

    /// Reads the ARA factory exposed by an `ARA Main Factory Class`.
    pub fn ara_factory_info(&self, class_id: ClassId) -> HostResult<AraFactoryInfo> {
        let class_id = class_id.to_tuid();
        let mut raw = std::mem::MaybeUninit::<YadawAraFactoryInfo>::zeroed();
        let result = unsafe {
            // SAFETY: the module factory is live, class_id is a VST3 ABI TUID, and raw is writable
            // storage. The bridge copies all plug-in-owned strings before releasing IMainFactory.
            yadaw_ara_query_factory(self.factory().as_ptr(), class_id.as_ptr(), raw.as_mut_ptr())
        };
        if result != 0 {
            return Err(HostError::Operation {
                operation: "ARA::IMainFactory::getFactory",
                result,
            });
        }
        let raw = unsafe {
            // SAFETY: a successful bridge call initialized the complete POD output structure.
            raw.assume_init()
        };
        Ok(AraFactoryInfo {
            factory_id: fixed_c_string(&raw.factory_id),
            document_archive_id: fixed_c_string(&raw.document_archive_id),
            plugin_name: fixed_c_string(&raw.plugin_name),
            manufacturer_name: fixed_c_string(&raw.manufacturer_name),
            version: fixed_c_string(&raw.version),
            lowest_api_generation: raw.lowest_api_generation,
            highest_api_generation: raw.highest_api_generation,
            playback_transformation_flags: raw.playback_transformation_flags,
            supports_storing_audio_file_chunks: raw.supports_storing_audio_file_chunks != 0,
        })
    }
}

fn class_subcategories(factory2: &ComPtr<IPluginFactory2>, index: i32) -> Option<String> {
    let table = unsafe {
        // SAFETY: factory2 is a live IPluginFactory2 and begins with its vtable.
        *factory2.as_ptr().cast::<*const PluginFactory2VTable>()
    };
    let mut raw = std::mem::MaybeUninit::<PClassInfo2>::zeroed();
    let result = unsafe {
        // SAFETY: raw is writable SDK storage and index is within countClasses().
        ((*table).get_class_info2)(factory2.as_ptr(), index, raw.as_mut_ptr())
    };
    if result != 0 {
        return None;
    }
    let raw = unsafe {
        // SAFETY: successful getClassInfo2 initialized the structure.
        raw.assume_init()
    };
    Some(fixed_c_string(&raw.subCategories))
}

impl Drop for Module {
    fn drop(&mut self) {
        self.factory.take();
        #[cfg(target_os = "macos")]
        {
            self.mac_bundle.take();
        }
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(exit) = self.exit {
                unsafe {
                    // SAFETY: all module interfaces were released above and the
                    // library remains loaded until this Drop returns.
                    exit();
                }
            }
            let _keep_loaded = &self.library;
        }
    }
}
