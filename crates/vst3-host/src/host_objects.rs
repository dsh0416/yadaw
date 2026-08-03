use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_void},
    os::raw::c_char,
    ptr,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU32, Ordering, fence},
    },
};

use heron_vst3_host_sys::{
    Steinberg::{
        FIDString, FUnknown, TUID,
        Vst::{IAttributeList, IMessage},
        int64, tresult, uint32,
    },
    abi::{AttributeListVTable, FUnknownVTable, MessageVTable},
    iid,
};

const RESULT_OK: tresult = 0;
const RESULT_FALSE: tresult = 1;
const INVALID_ARGUMENT: tresult = -2147024809;
const NO_INTERFACE: tresult = -2147467262;

enum Attribute {
    Integer(int64),
    Float(f64),
    String(Vec<u16>),
    Binary(Vec<u8>),
}

#[repr(C)]
pub(crate) struct HostAttributeList {
    vtable: *const AttributeListVTable,
    references: AtomicU32,
    values: Mutex<HashMap<Vec<u8>, Attribute>>,
}

impl HostAttributeList {
    pub(crate) fn into_raw() -> *mut IAttributeList {
        Box::into_raw(Box::new(Self {
            vtable: &ATTRIBUTE_LIST_VTABLE,
            references: AtomicU32::new(1),
            values: Mutex::new(HashMap::new()),
        }))
        .cast()
    }

    pub(crate) fn project_state() -> *mut IAttributeList {
        let attributes = Self::into_raw();
        let state_type = "Project\0".encode_utf16().collect::<Vec<_>>();
        unsafe {
            // SAFETY: attributes is a newly owned host list, the static ID is NUL-terminated,
            // and state_type remains readable for this synchronous copy.
            set_string(attributes, c"StateType".as_ptr(), state_type.as_ptr());
        }
        attributes
    }
}

#[repr(C)]
pub(crate) struct HostMessage {
    vtable: *const MessageVTable,
    references: AtomicU32,
    message_id: Mutex<Option<CString>>,
    attributes: *mut IAttributeList,
}

impl HostMessage {
    pub(crate) fn into_raw() -> *mut IMessage {
        Box::into_raw(Box::new(Self {
            vtable: &MESSAGE_VTABLE,
            references: AtomicU32::new(1),
            message_id: Mutex::new(None),
            attributes: HostAttributeList::into_raw(),
        }))
        .cast()
    }
}

impl Drop for HostMessage {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: the message owns one reference to the separately allocated
            // attribute list for its entire lifetime.
            attribute_release(self.attributes.cast());
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

unsafe fn requested_iid<'a>(requested: *const c_char) -> Option<&'a [c_char]> {
    if requested.is_null() {
        return None;
    }
    Some(unsafe {
        // SAFETY: VST3 queryInterface supplies a 16-byte TUID.
        std::slice::from_raw_parts(requested, 16)
    })
}

unsafe fn write_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
    own_iid: &TUID,
    add_ref: unsafe extern "system" fn(*mut FUnknown) -> uint32,
) -> tresult {
    if output.is_null() {
        return INVALID_ARGUMENT;
    }
    // SAFETY: queryInterface's contract supplies a readable TUID when non-null.
    let Some(requested) = (unsafe { requested_iid(requested) }) else {
        unsafe {
            // SAFETY: output was validated above.
            output.write(ptr::null_mut());
        }
        return INVALID_ARGUMENT;
    };
    if requested == iid::FUNKNOWN || requested == own_iid {
        unsafe {
            // SAFETY: both supported interfaces use the object's leading vtable.
            output.write(this.cast());
            add_ref(this);
        }
        RESULT_OK
    } else {
        unsafe {
            // SAFETY: output was validated above.
            output.write(ptr::null_mut());
        }
        NO_INTERFACE
    }
}

unsafe extern "system" fn message_query_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
) -> tresult {
    // SAFETY: the callback arguments follow the VST3 queryInterface contract.
    unsafe { write_interface(this, requested, output, &iid::IMESSAGE, message_add_ref) }
}

unsafe extern "system" fn message_add_ref(this: *mut FUnknown) -> uint32 {
    let message = this.cast::<HostMessage>();
    unsafe {
        // SAFETY: this is the leading interface pointer of a live HostMessage.
        (*message).references.fetch_add(1, Ordering::Relaxed) + 1
    }
}

unsafe extern "system" fn message_release(this: *mut FUnknown) -> uint32 {
    let message = this.cast::<HostMessage>();
    let previous = unsafe {
        // SAFETY: this is the leading interface pointer of a live HostMessage.
        (*message).references.fetch_sub(1, Ordering::Release)
    };
    let remaining = previous.saturating_sub(1);
    if previous == 1 {
        fence(Ordering::Acquire);
        unsafe {
            // SAFETY: this was the final owned reference and the object came from Box::into_raw.
            drop(Box::from_raw(message));
        }
    }
    remaining
}

unsafe extern "system" fn get_message_id(this: *mut IMessage) -> FIDString {
    let message = this.cast::<HostMessage>();
    let message_id = unsafe {
        // SAFETY: this is the leading interface pointer of a live HostMessage.
        lock(&(*message).message_id)
    };
    message_id.as_ref().map_or(ptr::null(), |id| id.as_ptr())
}

unsafe extern "system" fn set_message_id(this: *mut IMessage, id: FIDString) {
    let message = this.cast::<HostMessage>();
    let mut message_id = unsafe {
        // SAFETY: this is the leading interface pointer of a live HostMessage.
        lock(&(*message).message_id)
    };
    *message_id = if id.is_null() {
        None
    } else {
        Some(
            unsafe {
                // SAFETY: VST3 requires message IDs to be null-terminated strings.
                CStr::from_ptr(id)
            }
            .to_owned(),
        )
    };
}

unsafe extern "system" fn get_attributes(this: *mut IMessage) -> *mut IAttributeList {
    unsafe {
        // SAFETY: this is a live HostMessage and its attribute list shares its lifetime.
        (*this.cast::<HostMessage>()).attributes
    }
}

unsafe extern "system" fn attribute_query_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
) -> tresult {
    // SAFETY: the callback arguments follow the VST3 queryInterface contract.
    unsafe {
        write_interface(
            this,
            requested,
            output,
            &iid::IATTRIBUTE_LIST,
            attribute_add_ref,
        )
    }
}

unsafe extern "system" fn attribute_add_ref(this: *mut FUnknown) -> uint32 {
    let attributes = this.cast::<HostAttributeList>();
    unsafe {
        // SAFETY: this is the leading interface pointer of a live HostAttributeList.
        (*attributes).references.fetch_add(1, Ordering::Relaxed) + 1
    }
}

pub(crate) unsafe extern "system" fn attribute_release(this: *mut FUnknown) -> uint32 {
    let attributes = this.cast::<HostAttributeList>();
    let previous = unsafe {
        // SAFETY: this is the leading interface pointer of a live HostAttributeList.
        (*attributes).references.fetch_sub(1, Ordering::Release)
    };
    let remaining = previous.saturating_sub(1);
    if previous == 1 {
        fence(Ordering::Acquire);
        unsafe {
            // SAFETY: this was the final owned reference and the object came from Box::into_raw.
            drop(Box::from_raw(attributes));
        }
    }
    remaining
}

unsafe fn attribute_key(id: FIDString) -> Option<Vec<u8>> {
    if id.is_null() {
        return None;
    }
    Some(
        unsafe {
            // SAFETY: VST3 attribute IDs are null-terminated strings.
            CStr::from_ptr(id)
        }
        .to_bytes()
        .to_vec(),
    )
}

unsafe fn attribute_values<'a>(
    this: *mut IAttributeList,
) -> Option<MutexGuard<'a, HashMap<Vec<u8>, Attribute>>> {
    let attributes = this.cast::<HostAttributeList>();
    if attributes.is_null() {
        return None;
    }
    Some(unsafe {
        // SAFETY: VST3 supplies a live HostAttributeList. The returned guard
        // cannot outlive that interface call.
        lock(&(*attributes).values)
    })
}

unsafe extern "system" fn set_int(
    this: *mut IAttributeList,
    id: FIDString,
    value: int64,
) -> tresult {
    // SAFETY: the callback supplies a live list and a null-terminated attribute ID.
    let Some(key) = (unsafe { attribute_key(id) }) else {
        return INVALID_ARGUMENT;
    };
    // SAFETY: this is the live interface pointer received by this callback.
    let Some(mut values) = (unsafe { attribute_values(this) }) else {
        return INVALID_ARGUMENT;
    };
    values.insert(key, Attribute::Integer(value));
    RESULT_OK
}

unsafe extern "system" fn get_int(
    this: *mut IAttributeList,
    id: FIDString,
    value: *mut int64,
) -> tresult {
    if value.is_null() {
        return INVALID_ARGUMENT;
    }
    // SAFETY: the callback supplies a null-terminated attribute ID.
    let Some(key) = (unsafe { attribute_key(id) }) else {
        return INVALID_ARGUMENT;
    };
    // SAFETY: this is the live interface pointer received by this callback.
    let Some(values) = (unsafe { attribute_values(this) }) else {
        return INVALID_ARGUMENT;
    };
    let Some(Attribute::Integer(stored)) = values.get(&key) else {
        return RESULT_FALSE;
    };
    unsafe {
        // SAFETY: value was validated and points to caller-provided output storage.
        value.write(*stored);
    }
    RESULT_OK
}

unsafe extern "system" fn set_float(
    this: *mut IAttributeList,
    id: FIDString,
    value: f64,
) -> tresult {
    // SAFETY: the callback supplies a null-terminated attribute ID.
    let Some(key) = (unsafe { attribute_key(id) }) else {
        return INVALID_ARGUMENT;
    };
    // SAFETY: this is the live interface pointer received by this callback.
    let Some(mut values) = (unsafe { attribute_values(this) }) else {
        return INVALID_ARGUMENT;
    };
    values.insert(key, Attribute::Float(value));
    RESULT_OK
}

unsafe extern "system" fn get_float(
    this: *mut IAttributeList,
    id: FIDString,
    value: *mut f64,
) -> tresult {
    if value.is_null() {
        return INVALID_ARGUMENT;
    }
    // SAFETY: the callback supplies a null-terminated attribute ID.
    let Some(key) = (unsafe { attribute_key(id) }) else {
        return INVALID_ARGUMENT;
    };
    // SAFETY: this is the live interface pointer received by this callback.
    let Some(values) = (unsafe { attribute_values(this) }) else {
        return INVALID_ARGUMENT;
    };
    let Some(Attribute::Float(stored)) = values.get(&key) else {
        return RESULT_FALSE;
    };
    unsafe {
        // SAFETY: value was validated and points to caller-provided output storage.
        value.write(*stored);
    }
    RESULT_OK
}

unsafe extern "system" fn set_string(
    this: *mut IAttributeList,
    id: FIDString,
    value: *const u16,
) -> tresult {
    if value.is_null() {
        return INVALID_ARGUMENT;
    }
    // SAFETY: the callback supplies a null-terminated attribute ID.
    let Some(key) = (unsafe { attribute_key(id) }) else {
        return INVALID_ARGUMENT;
    };
    let mut length = 0;
    unsafe {
        // SAFETY: VST3 requires attribute strings to be null-terminated UTF-16.
        while value.add(length).read() != 0 {
            length += 1;
        }
    }
    let stored = unsafe {
        // SAFETY: the scan above established length readable code units plus the terminator.
        std::slice::from_raw_parts(value, length + 1)
    }
    .to_vec();
    // SAFETY: this is the live interface pointer received by this callback.
    let Some(mut values) = (unsafe { attribute_values(this) }) else {
        return INVALID_ARGUMENT;
    };
    values.insert(key, Attribute::String(stored));
    RESULT_OK
}

unsafe extern "system" fn get_string(
    this: *mut IAttributeList,
    id: FIDString,
    value: *mut u16,
    size_in_bytes: uint32,
) -> tresult {
    if value.is_null() && size_in_bytes != 0 {
        return INVALID_ARGUMENT;
    }
    // SAFETY: the callback supplies a null-terminated attribute ID.
    let Some(key) = (unsafe { attribute_key(id) }) else {
        return INVALID_ARGUMENT;
    };
    // SAFETY: this is the live interface pointer received by this callback.
    let Some(values) = (unsafe { attribute_values(this) }) else {
        return INVALID_ARGUMENT;
    };
    let Some(Attribute::String(stored)) = values.get(&key) else {
        return RESULT_FALSE;
    };
    let code_units = stored.len().min(size_in_bytes as usize / size_of::<u16>());
    if code_units != 0 {
        unsafe {
            // SAFETY: the caller supplied size_in_bytes of writable output storage.
            ptr::copy_nonoverlapping(stored.as_ptr(), value, code_units);
        }
    }
    RESULT_OK
}

unsafe extern "system" fn set_binary(
    this: *mut IAttributeList,
    id: FIDString,
    data: *const c_void,
    size_in_bytes: uint32,
) -> tresult {
    if data.is_null() && size_in_bytes != 0 {
        return INVALID_ARGUMENT;
    }
    // SAFETY: the callback supplies a null-terminated attribute ID.
    let Some(key) = (unsafe { attribute_key(id) }) else {
        return INVALID_ARGUMENT;
    };
    let stored = if size_in_bytes == 0 {
        Vec::new()
    } else {
        unsafe {
            // SAFETY: the caller supplies size_in_bytes of readable binary data.
            std::slice::from_raw_parts(data.cast::<u8>(), size_in_bytes as usize)
        }
        .to_vec()
    };
    // SAFETY: this is the live interface pointer received by this callback.
    let Some(mut values) = (unsafe { attribute_values(this) }) else {
        return INVALID_ARGUMENT;
    };
    values.insert(key, Attribute::Binary(stored));
    RESULT_OK
}

unsafe extern "system" fn get_binary(
    this: *mut IAttributeList,
    id: FIDString,
    data: *mut *const c_void,
    size_in_bytes: *mut uint32,
) -> tresult {
    if data.is_null() || size_in_bytes.is_null() {
        return INVALID_ARGUMENT;
    }
    // SAFETY: the callback supplies a null-terminated attribute ID.
    let Some(key) = (unsafe { attribute_key(id) }) else {
        return INVALID_ARGUMENT;
    };
    // SAFETY: this is the live interface pointer received by this callback.
    let Some(values) = (unsafe { attribute_values(this) }) else {
        return INVALID_ARGUMENT;
    };
    if let Some(Attribute::Binary(stored)) = values.get(&key) {
        unsafe {
            // SAFETY: both caller-provided output pointers were validated above.
            data.write(stored.as_ptr().cast());
            size_in_bytes.write(stored.len() as uint32);
        }
        RESULT_OK
    } else {
        unsafe {
            // SAFETY: both caller-provided output pointers were validated above.
            data.write(ptr::null());
            size_in_bytes.write(0);
        }
        RESULT_FALSE
    }
}

static MESSAGE_VTABLE: MessageVTable = MessageVTable {
    base: FUnknownVTable {
        query_interface: message_query_interface,
        add_ref: message_add_ref,
        release: message_release,
    },
    get_message_id,
    set_message_id,
    get_attributes,
};

static ATTRIBUTE_LIST_VTABLE: AttributeListVTable = AttributeListVTable {
    base: FUnknownVTable {
        query_interface: attribute_query_interface,
        add_ref: attribute_add_ref,
        release: attribute_release,
    },
    set_int,
    get_int,
    set_float,
    get_float,
    set_string,
    get_string,
    set_binary,
    get_binary,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_owns_a_mutable_attribute_list() {
        // SAFETY: the test owns every raw COM reference and supplies valid buffers/IDs.
        unsafe {
            let message = HostMessage::into_raw();
            set_message_id(message, c"meter".as_ptr());
            assert_eq!(CStr::from_ptr(get_message_id(message)), c"meter");

            let attributes = get_attributes(message);
            assert!(!attributes.is_null());
            assert_eq!(set_int(attributes, c"channel".as_ptr(), 2), RESULT_OK);
            let mut channel = 0;
            assert_eq!(
                get_int(attributes, c"channel".as_ptr(), &mut channel),
                RESULT_OK
            );
            assert_eq!(channel, 2);

            let label = [b'L' as u16, b'R' as u16, 0];
            assert_eq!(
                set_string(attributes, c"label".as_ptr(), label.as_ptr()),
                RESULT_OK
            );
            let mut copied = [0_u16; 3];
            assert_eq!(
                get_string(
                    attributes,
                    c"label".as_ptr(),
                    copied.as_mut_ptr(),
                    size_of_val(&copied) as uint32,
                ),
                RESULT_OK
            );
            assert_eq!(copied, label);

            assert_eq!(message_release(message.cast()), 0);
        }
    }

    #[test]
    fn message_and_attribute_list_expose_their_com_interfaces() {
        // SAFETY: the test balances every raw COM reference returned by queryInterface.
        unsafe {
            let message = HostMessage::into_raw();
            let mut queried = ptr::null_mut();
            assert_eq!(
                message_query_interface(message.cast(), iid::IMESSAGE.as_ptr(), &mut queried),
                RESULT_OK
            );
            assert_eq!(queried, message.cast());
            assert_eq!(message_release(queried.cast()), 1);
            assert_eq!(message_release(message.cast()), 0);

            let attributes = HostAttributeList::into_raw();
            queried = ptr::null_mut();
            assert_eq!(
                attribute_query_interface(
                    attributes.cast(),
                    iid::IATTRIBUTE_LIST.as_ptr(),
                    &mut queried,
                ),
                RESULT_OK
            );
            assert_eq!(queried, attributes.cast());
            assert_eq!(attribute_release(queried.cast()), 1);
            assert_eq!(attribute_release(attributes.cast()), 0);
        }
    }
}
