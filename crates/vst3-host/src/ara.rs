use std::{ffi::c_void, ptr::NonNull};

use heron_vst3_host_sys::{
    HeronAraMainFactory, HeronAraPluginEntry,
    Steinberg::{FUnknown, IPluginFactory},
    heron_ara_main_factory_create, heron_ara_main_factory_destroy, heron_ara_main_factory_get,
    heron_ara_plugin_entry_bind, heron_ara_plugin_entry_create, heron_ara_plugin_entry_destroy,
    heron_ara_plugin_entry_get_factory,
};

use crate::{ClassId, HostError, HostResult};

pub struct AraMainFactory {
    raw: NonNull<HeronAraMainFactory>,
}

impl AraMainFactory {
    pub(crate) fn create(factory: *mut IPluginFactory, class_id: ClassId) -> HostResult<Self> {
        let class_id = class_id.to_tuid();
        let mut result = 0;
        let raw = unsafe {
            // SAFETY: factory remains live through the returned wrapper and class_id is a VST3
            // ABI TUID. The bridge owns the queried IMainFactory reference.
            heron_ara_main_factory_create(factory, class_id.as_ptr(), &mut result)
        };
        let raw = NonNull::new(raw).ok_or(HostError::Operation {
            operation: "create ARA main factory",
            result,
        })?;
        Ok(Self { raw })
    }

    #[must_use]
    pub fn factory_ptr(&self) -> *const c_void {
        unsafe {
            // SAFETY: raw owns the provider whose factory pointer remains stable.
            heron_ara_main_factory_get(self.raw.as_ptr()).cast()
        }
    }
}

impl Drop for AraMainFactory {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: raw was created once by the bridge and is uniquely owned here.
            heron_ara_main_factory_destroy(self.raw.as_ptr());
        }
    }
}

pub struct AraPluginEntry {
    raw: NonNull<HeronAraPluginEntry>,
}

impl AraPluginEntry {
    /// Queries ARA entry-point interfaces on an initialized VST3 component.
    ///
    /// # Safety
    ///
    /// `component` must remain live until this wrapper is dropped.
    pub unsafe fn discover(component: *mut c_void) -> HostResult<Self> {
        let mut result = 0;
        // SAFETY: forwarded caller contract; the bridge retains queried interfaces.
        let raw =
            unsafe { heron_ara_plugin_entry_create(component.cast::<FUnknown>(), &mut result) };
        let raw = NonNull::new(raw).ok_or(HostError::Operation {
            operation: "query ARA VST3 entry point",
            result,
        })?;
        Ok(Self { raw })
    }

    #[must_use]
    pub fn factory_ptr(&self) -> *const c_void {
        unsafe {
            // SAFETY: raw retains the entry-point provider.
            heron_ara_plugin_entry_get_factory(self.raw.as_ptr()).cast()
        }
    }

    /// Binds this component once to a live ARA document controller.
    ///
    /// # Safety
    ///
    /// The controller must remain live for the component lifetime and model-thread rules apply.
    pub unsafe fn bind(
        &self,
        controller: *mut c_void,
        known_roles: i32,
        assigned_roles: i32,
    ) -> HostResult<*const c_void> {
        let mut result = 0;
        // SAFETY: forwarded controller and role contract.
        let extension = unsafe {
            heron_ara_plugin_entry_bind(
                self.raw.as_ptr(),
                controller.cast(),
                known_roles,
                assigned_roles,
                &mut result,
            )
        };
        if extension.is_null() {
            Err(HostError::Operation {
                operation: "bind VST3 component to ARA document",
                result,
            })
        } else {
            Ok(extension.cast())
        }
    }
}

impl Drop for AraPluginEntry {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: raw was created once by the bridge and is uniquely owned here.
            heron_ara_plugin_entry_destroy(self.raw.as_ptr());
        }
    }
}
