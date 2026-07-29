use std::path::PathBuf;

/// Errors produced while loading or controlling a VST3 plug-in.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum HostError {
    /// A VST3 class identifier was malformed.
    #[error("invalid VST3 class identifier '{0}'")]
    InvalidClassId(String),
    /// A module could not be opened.
    #[error("could not open VST3 module at {path}: {source}")]
    ModuleOpen {
        /// The bundle or module path.
        path: PathBuf,
        /// The platform loader error.
        #[source]
        source: libloading::Error,
    },
    /// A VST3 bundle does not contain the platform module binary.
    #[error("could not locate a VST3 module binary in '{0}'")]
    ModuleBinary(PathBuf),
    /// A VST3 bundle could not be loaded through the platform module loader.
    #[error("could not load VST3 bundle at {path}: {message}")]
    BundleLoad {
        /// The bundle path passed to the loader.
        path: PathBuf,
        /// Platform-specific failure detail.
        message: String,
    },
    /// A required module entry point was not exported.
    #[error("VST3 module does not export '{0}'")]
    MissingEntryPoint(&'static str),
    /// The module returned an invalid null interface pointer.
    #[error("VST3 operation '{0}' returned a null interface")]
    NullInterface(&'static str),
    /// The plug-in rejected a lifecycle operation.
    #[error("VST3 operation '{operation}' failed with result {result:#010x}")]
    Operation {
        /// The VST3 operation name.
        operation: &'static str,
        /// The raw VST3 result code.
        result: i32,
    },
    /// The ARA companion lifecycle failed before the VST3 component could be activated.
    #[error("ARA host operation failed: {0}")]
    Ara(String),
}

/// Result type used by the safe VST3 host layer.
pub type HostResult<T> = Result<T, HostError>;
