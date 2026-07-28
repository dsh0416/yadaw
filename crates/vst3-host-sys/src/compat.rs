//! Cross-platform helpers for bindgen-generated Steinberg types.
//!
//! Bindgen maps C/C++ types to the target ABI (`c_char`, `c_int`, …). Call sites
//! must not hardcode Rust primitives such as `i8` / `i32` / `u32` when talking
//! to those aliases. Prefer Steinberg typedefs (`TUID`, `MediaType`, `uint32`)
//! and cast C++ enum constants to the **destination** typedef via the helpers
//! below.

use std::os::raw::{c_char, c_int};

use crate::Steinberg::{
    Vst::{BusDirection, MediaType},
    int32, uint32,
};

/// Converts a byte into a `TUID` / `char8` element for the current target.
#[inline]
#[must_use]
pub const fn tuid_byte(byte: u8) -> c_char {
    byte as c_char
}

/// Casts a bindgen C++ enum constant (`c_int`) to a Steinberg `int32` field or parameter.
#[inline]
#[must_use]
pub const fn as_int32(value: c_int) -> int32 {
    value as int32
}

/// Casts a bindgen C++ enum constant (`c_int`) to a Steinberg `uint32` field or parameter.
#[inline]
#[must_use]
pub const fn as_uint32(value: c_int) -> uint32 {
    value as uint32
}

/// Casts a media-type enum constant to the `MediaType` parameter typedef.
#[inline]
#[must_use]
pub const fn as_media_type(value: c_int) -> MediaType {
    as_int32(value)
}

/// Casts a bus-direction enum constant to the `BusDirection` parameter typedef.
#[inline]
#[must_use]
pub const fn as_bus_direction(value: c_int) -> BusDirection {
    as_int32(value)
}

/// Combines `ProcessContext_StatesAndFlags` enum constants into the `uint32` state field.
#[inline]
#[must_use]
pub fn process_context_state(flags: &[c_int]) -> uint32 {
    let mut state = 0_u32;
    for flag in flags {
        state |= as_uint32(*flag);
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
}
