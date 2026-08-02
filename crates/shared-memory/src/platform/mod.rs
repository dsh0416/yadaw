#[cfg(any(target_os = "linux", target_os = "macos"))]
mod posix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use posix::Mapping;
#[cfg(target_os = "windows")]
pub(crate) use windows::Mapping;
