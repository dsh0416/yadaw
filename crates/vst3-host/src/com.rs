use std::{ffi::c_void, marker::PhantomData, ptr::NonNull};

use heron_vst3_host_sys::{
    Steinberg::{
        FUnknown, IBStream, IPlugFrame, IPlugView, IPlugViewContentScaleSupport, IPluginBase,
        IPluginFactory, IPluginFactory2, IPluginFactory3, ISizeableStream,
        Linux::{IEventHandler, IRunLoop, ITimerHandler},
        TUID,
        Vst::{
            IAttributeList, IAudioPresentationLatency, IAudioProcessor, IComponent,
            IComponentHandler, IComponentHandler2, IComponentHandlerBusActivation,
            IConnectionPoint, IEditController, IEventList, IHostApplication, IMessage,
            IMidiMapping, IParamValueQueue, IParameterChanges, IProcessContextRequirements,
            IStreamAttributes, IUnitHandler, IUnitHandler2, IUnitInfo,
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
    const IID: TUID;
}

macro_rules! interface {
    ($type:ty, $iid:expr) => {
        impl private::Sealed for $type {}
        impl ComInterface for $type {
            const IID: TUID = $iid;
        }
    };
}

interface!(FUnknown, iid::FUNKNOWN);
interface!(IPluginBase, iid::IPLUGIN_BASE);
interface!(IPluginFactory, iid::IPLUGIN_FACTORY);
interface!(IPluginFactory2, iid::IPLUGIN_FACTORY2);
interface!(IPluginFactory3, iid::IPLUGIN_FACTORY3);
interface!(IBStream, iid::IBSTREAM);
interface!(ISizeableStream, iid::ISIZEABLE_STREAM);
interface!(IStreamAttributes, iid::ISTREAM_ATTRIBUTES);
interface!(IHostApplication, iid::IHOST_APPLICATION);
interface!(IMessage, iid::IMESSAGE);
interface!(IAttributeList, iid::IATTRIBUTE_LIST);
interface!(IComponent, iid::ICOMPONENT);
interface!(IAudioProcessor, iid::IAUDIO_PROCESSOR);
interface!(IAudioPresentationLatency, iid::IAUDIO_PRESENTATION_LATENCY);
interface!(
    IProcessContextRequirements,
    iid::IPROCESS_CONTEXT_REQUIREMENTS
);
interface!(IEditController, iid::IEDIT_CONTROLLER);
interface!(IMidiMapping, iid::IMIDI_MAPPING);
interface!(IComponentHandler, iid::ICOMPONENT_HANDLER);
interface!(IComponentHandler2, iid::ICOMPONENT_HANDLER2);
interface!(
    IComponentHandlerBusActivation,
    iid::ICOMPONENT_HANDLER_BUS_ACTIVATION
);
interface!(IUnitHandler, iid::IUNIT_HANDLER);
interface!(IUnitHandler2, iid::IUNIT_HANDLER2);
interface!(IUnitInfo, iid::IUNIT_INFO);
interface!(IEventList, iid::IEVENT_LIST);
interface!(IParameterChanges, iid::IPARAMETER_CHANGES);
interface!(IParamValueQueue, iid::IPARAM_VALUE_QUEUE);
interface!(IConnectionPoint, iid::ICONNECTION_POINT);
interface!(IPlugView, iid::IPLUG_VIEW);
interface!(IPlugFrame, iid::IPLUG_FRAME);
interface!(IEventHandler, iid::IEVENT_HANDLER);
interface!(ITimerHandler, iid::ITIMER_HANDLER);
interface!(IRunLoop, iid::IRUN_LOOP);
interface!(
    IPlugViewContentScaleSupport,
    iid::IPLUG_VIEW_CONTENT_SCALE_SUPPORT
);

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

    /// Retains one borrowed interface pointer and returns an owning reference.
    ///
    /// # Safety
    ///
    /// `pointer` must be a live borrowed pointer to `I` for the duration of this call, and its
    /// leading vtable must implement the matching `FUnknown` reference-counting methods.
    #[cfg(any(target_os = "linux", all(test, unix)))]
    pub(crate) unsafe fn retain_raw(pointer: *mut I, operation: &'static str) -> HostResult<Self> {
        let owned = unsafe {
            // SAFETY: the caller provides the validity and interface-layout guarantees.
            Self::from_raw(pointer, operation)?
        };
        unsafe {
            // SAFETY: owned contains the validated live interface pointer and every VST3
            // interface begins with the FUnknown vtable prefix.
            let unknown = owned.pointer.cast::<FUnknown>().as_ptr();
            ((*unknown_vtable(unknown)).add_ref)(unknown);
        }
        Ok(owned)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::raw::c_char,
        sync::atomic::{AtomicBool, AtomicU32, Ordering},
    };

    const INVALID_ARGUMENT: i32 = -2147024809;
    const NO_INTERFACE: i32 = -2147467262;

    #[repr(C)]
    struct FakeUnknown {
        vtable: *const FUnknownVTable,
        references: AtomicU32,
        null_on_success: AtomicBool,
    }

    impl FakeUnknown {
        fn new(null_on_success: bool) -> Box<Self> {
            Box::new(Self {
                vtable: &FAKE_UNKNOWN_VTABLE,
                references: AtomicU32::new(1),
                null_on_success: AtomicBool::new(null_on_success),
            })
        }

        fn as_unknown(&mut self) -> *mut FUnknown {
            std::ptr::from_mut(self).cast()
        }
    }

    unsafe extern "system" fn fake_query_interface(
        this: *mut FUnknown,
        requested: *const c_char,
        output: *mut *mut c_void,
    ) -> i32 {
        if requested.is_null() || output.is_null() {
            return INVALID_ARGUMENT;
        }
        // SAFETY: the test only installs this vtable on a live FakeUnknown allocation.
        let fake = unsafe { &*this.cast::<FakeUnknown>() };
        // SAFETY: callers supply a VST3 TUID, which is exactly 16 bytes.
        let requested = unsafe { std::slice::from_raw_parts(requested, 16) };
        if requested != iid::FUNKNOWN {
            // SAFETY: output was validated as non-null and points to writable pointer storage.
            unsafe { output.write(std::ptr::null_mut()) };
            return NO_INTERFACE;
        }
        if fake.null_on_success.load(Ordering::Relaxed) {
            // SAFETY: output was validated as non-null and points to writable pointer storage.
            unsafe { output.write(std::ptr::null_mut()) };
            return 0;
        }
        fake.references.fetch_add(1, Ordering::Relaxed);
        // SAFETY: output was validated and this is the requested live FUnknown interface.
        unsafe { output.write(this.cast()) };
        0
    }

    unsafe extern "system" fn fake_add_ref(this: *mut FUnknown) -> u32 {
        // SAFETY: the test only calls through this vtable while FakeUnknown is alive.
        let fake = unsafe { &*this.cast::<FakeUnknown>() };
        fake.references.fetch_add(1, Ordering::Relaxed) + 1
    }

    unsafe extern "system" fn fake_release(this: *mut FUnknown) -> u32 {
        // SAFETY: the test only calls through this vtable while FakeUnknown is alive and balances
        // every owned reference without underflowing the counter.
        let fake = unsafe { &*this.cast::<FakeUnknown>() };
        fake.references.fetch_sub(1, Ordering::Release) - 1
    }

    static FAKE_UNKNOWN_VTABLE: FUnknownVTable = FUnknownVTable {
        query_interface: fake_query_interface,
        add_ref: fake_add_ref,
        release: fake_release,
    };

    #[test]
    fn com_ptr_rejects_null_owned_interfaces() {
        // SAFETY: a null pointer is intentionally supplied to verify validation before use.
        let result = unsafe { ComPtr::<FUnknown>::from_raw(std::ptr::null_mut(), "fixture") };
        assert!(matches!(result, Err(HostError::NullInterface("fixture"))));
    }

    #[test]
    fn com_ptr_clone_query_and_drop_balance_owned_references() {
        let mut fake = FakeUnknown::new(false);
        let raw = fake.as_unknown();
        // SAFETY: raw points to the live FakeUnknown, which owns one initial reference and starts
        // with the matching FUnknown vtable.
        let owner =
            unsafe { ComPtr::<FUnknown>::from_raw(raw, "fixture") }.expect("owned fake interface");
        assert_eq!(fake.references.load(Ordering::Relaxed), 1);

        let cloned = owner.clone();
        assert_eq!(fake.references.load(Ordering::Relaxed), 2);
        drop(cloned);
        assert_eq!(fake.references.load(Ordering::Relaxed), 1);

        let queried = owner.query::<FUnknown>().expect("query FUnknown");
        assert_eq!(queried.as_ptr(), raw);
        assert_eq!(fake.references.load(Ordering::Relaxed), 2);
        drop(queried);
        assert_eq!(fake.references.load(Ordering::Relaxed), 1);

        drop(owner);
        assert_eq!(fake.references.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn com_ptr_query_reports_unsupported_and_null_success_results() {
        let mut unsupported = FakeUnknown::new(false);
        // SAFETY: the fake owns one initial reference and exposes a valid FUnknown vtable.
        let owner = unsafe {
            ComPtr::<FUnknown>::from_raw(unsupported.as_unknown(), "unsupported fixture")
        }
        .expect("owned unsupported fixture");
        assert!(matches!(
            owner.query::<IBStream>(),
            Err(HostError::Operation {
                operation: "queryInterface",
                result: NO_INTERFACE,
            })
        ));
        drop(owner);
        assert_eq!(unsupported.references.load(Ordering::Relaxed), 0);

        let mut null_success = FakeUnknown::new(true);
        // SAFETY: the fake owns one initial reference and exposes a valid FUnknown vtable.
        let owner = unsafe {
            ComPtr::<FUnknown>::from_raw(null_success.as_unknown(), "null-success fixture")
        }
        .expect("owned null-success fixture");
        assert!(matches!(
            owner.query::<FUnknown>(),
            Err(HostError::NullInterface("queryInterface"))
        ));
        drop(owner);
        assert_eq!(null_success.references.load(Ordering::Relaxed), 0);
    }
}
