use std::{ffi::c_void, rc::Rc};

use heron_vst3_host_sys::{
    Steinberg::{
        IPlugFrame, IPlugView, IPlugViewContentScaleSupport, IPluginBase, TUID, ViewRect,
        Vst::{
            IComponent, IConnectionPoint, IEditController, IMidiMapping, IUnitInfo, ParameterInfo,
        },
    },
    abi::{
        ComponentVTable, ConnectionPointVTable, EditControllerVTable, MidiMappingVTable,
        PlugViewContentScaleSupportVTable, PlugViewVTable, UnitInfoVTable,
    },
    compat::{as_uint32, tuid_byte},
};

use crate::{ClassId, ComPtr, HostError, HostResult, Module, StereoProcessor};

#[cfg(target_os = "windows")]
unsafe extern "C" {
    fn heron_vst3_guarded_attach(
        view: *mut IPlugView,
        parent: *mut c_void,
        platform: *const std::ffi::c_char,
    ) -> i32;
}

pub struct PlugView {
    pub(super) view: ComPtr<IPlugView>,
}

impl PlugView {
    #[must_use]
    pub fn as_ptr(&self) -> *mut IPlugView {
        self.view.as_ptr()
    }

    pub fn supports_platform(&self, platform: &'static std::ffi::CStr) -> bool {
        unsafe {
            // SAFETY: view and static platform string are live.
            ((*view_table(&self.view)).is_platform_type_supported)(
                self.view.as_ptr(),
                platform.as_ptr(),
            ) == 0
        }
    }

    pub fn size(&self) -> HostResult<ViewRect> {
        let mut size = ViewRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        check("IPlugView::getSize", unsafe {
            // SAFETY: view is live and size is writable.
            ((*view_table(&self.view)).size)(self.view.as_ptr(), &mut size)
        })?;
        Ok(size)
    }

    pub fn can_resize(&self) -> bool {
        unsafe {
            // SAFETY: view is live.
            ((*view_table(&self.view)).can_resize)(self.view.as_ptr()) == 0
        }
    }

    pub fn constrain_size(&self, size: &mut ViewRect) -> HostResult<()> {
        check("IPlugView::checkSizeConstraint", unsafe {
            // SAFETY: view is live and size is writable.
            ((*view_table(&self.view)).check_size_constraint)(self.view.as_ptr(), size)
        })
    }

    /// # Safety
    ///
    /// `frame` must be null or point to a live `IPlugFrame` that remains valid
    /// until this view is cleared with another `set_frame` call.
    pub unsafe fn set_frame(&self, frame: *mut IPlugFrame) -> HostResult<()> {
        check("IPlugView::setFrame", unsafe {
            // SAFETY: view is live and frame is either null or retained by the editor window.
            ((*view_table(&self.view)).set_frame)(self.view.as_ptr(), frame)
        })
    }

    /// # Safety
    ///
    /// `parent` must be a live native container of `platform` and must remain
    /// valid until [`Self::removed`] is called.
    pub unsafe fn attach(
        &self,
        parent: *mut c_void,
        platform: &'static std::ffi::CStr,
    ) -> HostResult<()> {
        #[cfg(target_os = "windows")]
        let result = unsafe {
            // SAFETY: the platform-specific child container stays alive until removed. The
            // narrow native guard converts a third-party structured exception into a failed
            // attach result so the host can fall back to its parameter editor.
            heron_vst3_guarded_attach(self.view.as_ptr(), parent, platform.as_ptr())
        };
        #[cfg(not(target_os = "windows"))]
        let result = unsafe {
            // SAFETY: the platform-specific child container stays alive until removed.
            let table = view_table(&self.view);
            ((*table).attached)(self.view.as_ptr(), parent, platform.as_ptr())
        };
        check("IPlugView::attached", result)
    }

    pub fn removed(&self) {
        unsafe {
            // SAFETY: view is attached at most once and removal is idempotently tracked by caller.
            ((*view_table(&self.view)).removed)(self.view.as_ptr());
        }
    }

    pub fn on_size(&self, size: &mut ViewRect) -> HostResult<()> {
        check("IPlugView::onSize", unsafe {
            // SAFETY: view is live and size uses the platform coordinate unit.
            ((*view_table(&self.view)).on_size)(self.view.as_ptr(), size)
        })
    }

    /// Notifies a view from an `IPlugFrame::resizeView` callback without
    /// borrowing the host-owned [`PlugView`]. This is required because VST3
    /// permits `resizeView` to be called synchronously from `attached`.
    ///
    /// # Safety
    ///
    /// `view` must be the live view passed to the matching frame callback and
    /// `size` must use that platform's VST3 coordinate unit.
    pub unsafe fn on_size_raw(view: *mut IPlugView, size: &mut ViewRect) -> HostResult<()> {
        if view.is_null() {
            return Err(HostError::NullInterface("IPlugView"));
        }
        let table = unsafe {
            // SAFETY: the caller guarantees a live IPlugView interface.
            *view.cast::<*const PlugViewVTable>()
        };
        check("IPlugView::onSize", unsafe {
            // SAFETY: view and writable size satisfy this method's contract.
            ((*table).on_size)(view, size)
        })
    }

    pub fn set_content_scale_factor(&self, factor: f32) -> HostResult<bool> {
        let Ok(scale) = self.view.query::<IPlugViewContentScaleSupport>() else {
            return Ok(false);
        };
        let table = unsafe {
            // SAFETY: ComPtr guarantees the leading content-scale vtable pointer.
            *scale
                .as_ptr()
                .cast::<*const PlugViewContentScaleSupportVTable>()
        };
        Ok(unsafe {
            // SAFETY: scale interface is live and factor is supplied by validated host settings.
            ((*table).set_content_scale_factor)(scale.as_ptr(), factor) == 0
        })
    }
}

pub(super) fn create_controller(
    module: &Rc<Module>,
    processor: &StereoProcessor,
) -> HostResult<(Option<ComPtr<IEditController>>, bool)> {
    let mut controller_id: TUID = [tuid_byte(0); 16];
    let result = unsafe {
        // SAFETY: component is initialized and controller_id is writable TUID storage.
        ((*component_table(processor.component())).get_controller_class_id)(
            processor.component().as_ptr(),
            controller_id.as_mut_ptr(),
        )
    };
    if result != 0 {
        return Ok((processor.component().query::<IEditController>().ok(), false));
    }
    let controller = module.create::<IEditController>(ClassId::from_tuid(controller_id))?;
    check("IEditController::initialize", unsafe {
        // SAFETY: controller is newly created and shares the live host context.
        ((*controller_table(&controller)).base.initialize)(
            controller.as_ptr().cast::<IPluginBase>(),
            processor.host().as_unknown(),
        )
    })?;
    Ok((Some(controller), true))
}

pub(super) fn controller_parameter_ids(
    controller: &ComPtr<IEditController>,
) -> HostResult<Vec<u32>> {
    let table = controller_table(controller);
    let count = unsafe {
        // SAFETY: controller is initialized and live on its owning UI thread.
        ((*table).parameter_count)(controller.as_ptr())
    }
    .max(0);
    let mut ids = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut raw = std::mem::MaybeUninit::<ParameterInfo>::zeroed();
        check("IEditController::getParameterInfo(output bridge)", unsafe {
            // SAFETY: index is below parameter_count and raw is writable SDK storage.
            ((*table).parameter_info)(controller.as_ptr(), index, raw.as_mut_ptr())
        })?;
        let raw = unsafe {
            // SAFETY: a successful parameter_info call initialized the POD.
            raw.assume_init()
        };
        ids.push(raw.id);
    }
    Ok(ids)
}

pub(super) fn controller_parameter_flags(
    controller: &ComPtr<IEditController>,
    id: u32,
) -> HostResult<Option<u32>> {
    let table = controller_table(controller);
    let count = unsafe {
        // SAFETY: controller is initialized and live on its owning UI thread.
        ((*table).parameter_count)(controller.as_ptr())
    }
    .max(0);
    for index in 0..count {
        let mut raw = std::mem::MaybeUninit::<ParameterInfo>::zeroed();
        check("IEditController::getParameterInfo(flags)", unsafe {
            // SAFETY: index is below parameter_count and raw is writable SDK storage.
            ((*table).parameter_info)(controller.as_ptr(), index, raw.as_mut_ptr())
        })?;
        let raw = unsafe {
            // SAFETY: successful parameter_info initialized the POD.
            raw.assume_init()
        };
        if raw.id == id {
            return Ok(Some(as_uint32(raw.flags)));
        }
    }
    Ok(None)
}

pub(super) fn component_table(component: &ComPtr<IComponent>) -> *const ComponentVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *component.as_ptr().cast::<*const ComponentVTable>()
    }
}

pub(super) fn midi_mapping_table(mapping: &ComPtr<IMidiMapping>) -> *const MidiMappingVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *mapping.as_ptr().cast::<*const MidiMappingVTable>()
    }
}

pub(super) fn unit_info_table(unit_info: &ComPtr<IUnitInfo>) -> *const UnitInfoVTable {
    unsafe {
        // SAFETY: ComPtr guarantees a live IUnitInfo with the matching leading vtable.
        *unit_info.as_ptr().cast::<*const UnitInfoVTable>()
    }
}

pub(super) fn controller_table(
    controller: &ComPtr<IEditController>,
) -> *const EditControllerVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *controller.as_ptr().cast::<*const EditControllerVTable>()
    }
}

pub(super) fn connection_table(
    connection: &ComPtr<IConnectionPoint>,
) -> *const ConnectionPointVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *connection.as_ptr().cast::<*const ConnectionPointVTable>()
    }
}

fn view_table(view: &ComPtr<IPlugView>) -> *const PlugViewVTable {
    unsafe {
        // SAFETY: ComPtr guarantees the object's leading vtable pointer.
        *view.as_ptr().cast::<*const PlugViewVTable>()
    }
}

pub(super) fn utf16_string(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

pub(super) fn optional_unit_string_result(
    operation: &'static str,
    result: i32,
    value: &[u16],
) -> HostResult<Option<String>> {
    match result {
        0 => Ok(Some(utf16_string(value))),
        1 => Ok(None),
        result => Err(HostError::Operation { operation, result }),
    }
}

pub(super) fn check(operation: &'static str, result: i32) -> HostResult<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(HostError::Operation { operation, result })
    }
}

pub(super) fn is_not_implemented(result: i32) -> bool {
    // SDK-native kNotImplemented on macOS/Linux plus the COM-compatible
    // encodings used by Windows toolchains and some cross-platform wrappers.
    [3, 0x8000_4001_u32 as i32, 0x8000_0001_u32 as i32].contains(&result)
}

pub(super) fn check_optional_controller_state(
    operation: &'static str,
    result: i32,
) -> HostResult<()> {
    if result == 0 || is_not_implemented(result) {
        Ok(())
    } else {
        Err(HostError::Operation { operation, result })
    }
}
