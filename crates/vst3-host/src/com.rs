use std::{ffi::c_void, marker::PhantomData, ptr::NonNull};

use yadaw_vst3_host_sys::{
    Steinberg::{
        FUnknown, IBStream, IPlugFrame, IPlugView, IPluginBase, IPluginFactory, IPluginFactory2,
        IPluginFactory3,
        Vst::{
            IAudioProcessor, IComponent, IComponentHandler, IConnectionPoint, IEditController,
            IEventList, IHostApplication, IParamValueQueue, IParameterChanges,
        },
    },
    abi::FUnknownVTable,
    iid,
};

use crate::{HostError, HostResult};

mod private {
    pub trait Sealed {}
}

/// A VST3 COM-style interface with a stable SDK interface identifier.
///
/// Implementations are sealed because each interface must use the exact
/// vtable layout declared by the selected VST3 SDK version.
pub trait ComInterface: private::Sealed {
    /// The target-specific interface identifier.
    const IID: [i8; 16];
}

macro_rules! interface {
    ($type:ty, $iid:expr) => {
        impl private::Sealed for $type {}
        impl ComInterface for $type {
            const IID: [i8; 16] = $iid;
        }
    };
}

interface!(FUnknown, iid::FUNKNOWN);
interface!(IPluginBase, iid::IPLUGIN_BASE);
interface!(IPluginFactory, iid::IPLUGIN_FACTORY);
interface!(IPluginFactory2, iid::IPLUGIN_FACTORY2);
interface!(IPluginFactory3, iid::IPLUGIN_FACTORY3);
interface!(IBStream, iid::IBSTREAM);
interface!(IHostApplication, iid::IHOST_APPLICATION);
interface!(IComponent, iid::ICOMPONENT);
interface!(IAudioProcessor, iid::IAUDIO_PROCESSOR);
interface!(IEditController, iid::IEDIT_CONTROLLER);
interface!(IComponentHandler, iid::ICOMPONENT_HANDLER);
interface!(IEventList, iid::IEVENT_LIST);
interface!(IParameterChanges, iid::IPARAMETER_CHANGES);
interface!(IParamValueQueue, iid::IPARAM_VALUE_QUEUE);
interface!(IConnectionPoint, iid::ICONNECTION_POINT);
interface!(IPlugView, iid::IPLUG_VIEW);
interface!(IPlugFrame, iid::IPLUG_FRAME);

/// An owning reference-counted pointer to one VST3 interface.
#[repr(transparent)]
pub struct ComPtr<I: ComInterface> {
    pointer: NonNull<I>,
    marker: PhantomData<I>,
}

impl<I: ComInterface> ComPtr<I> {
    /// Takes ownership of one reference returned by a VST3 API.
    ///
    /// # Safety
    ///
    /// `pointer` must be a valid pointer to `I` with one reference owned by
    /// the caller, and its first field must point to the matching VST3 vtable.
    pub unsafe fn from_raw(pointer: *mut I, operation: &'static str) -> HostResult<Self> {
        let pointer = NonNull::new(pointer).ok_or(HostError::NullInterface(operation))?;
        Ok(Self {
            pointer,
            marker: PhantomData,
        })
    }

    /// Borrows the raw interface pointer without changing its reference count.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut I {
        self.pointer.as_ptr()
    }

    /// Queries another interface exposed by the same VST3 object.
    pub fn query<J: ComInterface>(&self) -> HostResult<ComPtr<J>> {
        let mut output = std::ptr::null_mut::<c_void>();
        let result = unsafe {
            // SAFETY: ComPtr guarantees a live interface. Every VST3
            // interface begins with the FUnknown methods, and output points to
            // writable storage for the returned owned reference.
            let unknown = self.pointer.cast::<FUnknown>().as_ptr();
            let table = unknown_vtable(unknown);
            ((*table).query_interface)(unknown, J::IID.as_ptr(), std::ptr::addr_of_mut!(output))
        };
        if result != 0 {
            return Err(HostError::Operation {
                operation: "queryInterface",
                result,
            });
        }
        unsafe {
            // SAFETY: A successful queryInterface returns one owned reference
            // whose concrete interface matches J::IID.
            ComPtr::from_raw(output.cast::<J>(), "queryInterface")
        }
    }
}

impl<I: ComInterface> Clone for ComPtr<I> {
    fn clone(&self) -> Self {
        unsafe {
            // SAFETY: ComPtr guarantees a live interface and FUnknown is the
            // first vtable prefix of every VST3 interface.
            let unknown = self.pointer.cast::<FUnknown>().as_ptr();
            let table = unknown_vtable(unknown);
            ((*table).add_ref)(unknown);
        }
        Self {
            pointer: self.pointer,
            marker: PhantomData,
        }
    }
}

impl<I: ComInterface> Drop for ComPtr<I> {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: this ComPtr owns exactly one reference and remains valid
            // until release returns.
            let unknown = self.pointer.cast::<FUnknown>().as_ptr();
            let table = unknown_vtable(unknown);
            ((*table).release)(unknown);
        }
    }
}

unsafe fn unknown_vtable(pointer: *mut FUnknown) -> *const FUnknownVTable {
    unsafe {
        // SAFETY: guaranteed by ComPtr::from_raw. The generated abstract C++
        // object is represented by its leading vtable pointer.
        *pointer.cast::<*const FUnknownVTable>()
    }
}
