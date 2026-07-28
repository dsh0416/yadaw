use std::{
    ffi::{OsStr, c_void},
    path::{Path, PathBuf},
};

use libloading::{Library, Symbol};
use yadaw_vst3_host_sys::{
    Steinberg::{IPluginFactory, PClassInfo},
    abi::{GetPluginFactory, PluginFactoryVTable},
};

use crate::{ClassId, ComInterface, ComPtr, HostError, HostResult};

/// Stable metadata exposed by the base VST3 factory interface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassInfo {
    pub id: ClassId,
    pub category: String,
    pub name: String,
}

/// A loaded VST3 module and its root factory.
///
/// Field order is intentional: the factory is released before the dynamic
/// library is unloaded.
pub struct Module {
    factory: Option<ComPtr<IPluginFactory>>,
    library: Library,
    binary_path: PathBuf,
    exit: Option<unsafe extern "system" fn() -> bool>,
}

impl Module {
    /// Loads a VST3 bundle or direct module binary.
    pub fn open(path: impl AsRef<Path>) -> HostResult<Self> {
        let path = path.as_ref();
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
        let exit = {
            // SAFETY: the optional module lifecycle functions have the SDK
            // signatures and remain valid while Library is owned below.
            #[cfg(target_os = "windows")]
            unsafe {
                if let Ok(init) = library.get::<unsafe extern "system" fn() -> bool>(b"InitDll\0")
                    && !init()
                {
                    return Err(HostError::Operation {
                        operation: "InitDll",
                        result: 1,
                    });
                }
                library
                    .get::<unsafe extern "system" fn() -> bool>(b"ExitDll\0")
                    .ok()
                    .map(|symbol| *symbol)
            }
            #[cfg(not(target_os = "windows"))]
            {
                None
            }
        };
        let factory = unsafe {
            // SAFETY: the VST3 ABI defines this exact entry point signature.
            let entry: Symbol<'_, GetPluginFactory> = library
                .get(b"GetPluginFactory\0")
                .map_err(|_| HostError::MissingEntryPoint("GetPluginFactory"))?;
            ComPtr::from_raw(entry(), "GetPluginFactory")?
        };
        Ok(Self {
            factory: Some(factory),
            library,
            binary_path,
            exit,
        })
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
            classes.push(ClassInfo {
                id: ClassId::from_tuid(raw.cid),
                category: fixed_c_string(&raw.category),
                name: fixed_c_string(&raw.name),
            });
        }
        Ok(classes)
    }
}

impl Drop for Module {
    fn drop(&mut self) {
        self.factory.take();
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

fn fixed_c_string<const N: usize>(bytes: &[i8; N]) -> String {
    let length = bytes.iter().position(|value| *value == 0).unwrap_or(N);
    String::from_utf8_lossy(
        &bytes[..length]
            .iter()
            .map(|value| *value as u8)
            .collect::<Vec<_>>(),
    )
    .into_owned()
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
    #[cfg(target_os = "macos")]
    let candidates = [path.join("Contents").join("MacOS").join(stem)];
    #[cfg(target_os = "linux")]
    let candidates = [
        path.join("Contents")
            .join("x86_64-linux")
            .join(format!("{stem}.so")),
        path.join("Contents")
            .join("aarch64-linux")
            .join(format!("{stem}.so")),
    ];
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let candidates: [PathBuf; 0] = [];
    candidates.into_iter().find(|candidate| candidate.is_file())
}
