//! Cross-platform helpers for bindgen-generated Steinberg types.
//!
//! Bindgen maps C/C++ types to the target ABI (`c_char`, `c_int`, …). Call sites
//! must not hardcode Rust primitives such as `i8` / `i32` / `u32` when talking
//! to those aliases. Prefer Steinberg typedefs (`TUID`, `MediaType`, `uint32`)
//! and cast C++ enum constants to the **destination** typedef via the helpers
//! below.
//!
//! Bindgen may type C++ unscoped enum constants as signed (`c_int` / `i32`) or
//! unsigned (`u32`) depending on the target toolchain. [`BindgenEnum`] accepts
//! both so call sites stay identical across Windows, Linux, and macOS.

use std::os::raw::c_char;

use crate::Steinberg::{
    Vst::{BusDirection, MediaType},
    int32, uint32,
};

/// Integer shapes bindgen may use for C++ unscoped enum constants.
pub trait BindgenEnum: Copy {
    fn to_i32(self) -> i32;
    fn to_u32(self) -> u32;
}

macro_rules! impl_bindgen_enum {
    ($($ty:ty),+ $(,)?) => {
        $(
            impl BindgenEnum for $ty {
                #[inline]
                fn to_i32(self) -> i32 {
                    self as i32
                }

                #[inline]
                fn to_u32(self) -> u32 {
                    self as u32
                }
            }
        )+
    };
}

impl_bindgen_enum!(i8, u8, i16, u16, i32, u32, i64, u64, isize, usize);

/// Converts a byte into a `TUID` / `char8` element for the current target.
#[inline]
#[must_use]
pub const fn tuid_byte(byte: u8) -> c_char {
    byte as c_char
}

/// Casts a bindgen C++ enum constant to a Steinberg `int32` field or parameter.
#[inline]
#[must_use]
pub fn as_int32(value: impl BindgenEnum) -> int32 {
    value.to_i32()
}

/// Casts a bindgen C++ enum constant to a Steinberg `uint32` field or parameter.
#[inline]
#[must_use]
pub fn as_uint32(value: impl BindgenEnum) -> uint32 {
    value.to_u32()
}

/// Casts a media-type enum constant to the `MediaType` parameter typedef.
#[inline]
#[must_use]
pub fn as_media_type(value: impl BindgenEnum) -> MediaType {
    as_int32(value)
}

/// Casts a bus-direction enum constant to the `BusDirection` parameter typedef.
#[inline]
#[must_use]
pub fn as_bus_direction(value: impl BindgenEnum) -> BusDirection {
    as_int32(value)
}

/// Combines `ProcessContext_StatesAndFlags` enum constants into the `uint32` state field.
#[inline]
#[must_use]
pub fn process_context_state<E: BindgenEnum>(flags: &[E]) -> uint32 {
    let mut state = 0_u32;
    for flag in flags {
        state |= flag.to_u32();
    }
    state
}

#[cfg(test)]
mod tests {
    use std::{mem, os::raw::c_char};

    use crate::Steinberg::{TUID, Vst, uint32};

    use super::*;

    #[test]
    fn tuid_elements_match_c_char() {
        let tuid: TUID = [tuid_byte(0x7f); 16];
        let _: c_char = tuid[0];
        assert_eq!(mem::size_of::<TUID>(), 16 * mem::size_of::<c_char>());
    }

    #[test]
    fn process_context_state_is_uint32() {
        let state = process_context_state(&[
            Vst::ProcessContext_StatesAndFlags_kPlaying,
            Vst::ProcessContext_StatesAndFlags_kRecording,
        ]);
        let _: uint32 = state;
        assert_eq!(
            state,
            as_uint32(Vst::ProcessContext_StatesAndFlags_kPlaying)
                | as_uint32(Vst::ProcessContext_StatesAndFlags_kRecording)
        );
    }

    #[test]
    fn enum_casts_preserve_values() {
        assert_eq!(as_int32(Vst::ProcessModes_kRealtime), 0);
        assert_eq!(as_media_type(Vst::MediaTypes_kAudio), 0);
        assert_eq!(as_bus_direction(Vst::BusDirections_kInput), 0);
    }

    #[test]
    fn bindgen_enum_accepts_signed_and_unsigned() {
        assert_eq!(as_int32(0_i32), 0);
        assert_eq!(as_int32(0_u32), 0);
        assert_eq!(as_uint32(2_i32), 2);
        assert_eq!(as_uint32(2_u32), 2);
        assert_eq!(process_context_state(&[1_i32, 2_i32]), 3);
        assert_eq!(process_context_state(&[1_u32, 2_u32]), 3);
    }
}
