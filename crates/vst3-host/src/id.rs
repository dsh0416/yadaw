use std::{fmt, os::raw::c_char, str::FromStr};

use heron_vst3_host_sys::{Steinberg::TUID, compat::tuid_byte};

use crate::HostError;

/// A validated 16-byte VST3 class or interface identifier.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct ClassId([u8; 16]);

impl ClassId {
    /// Creates an identifier from its native 16-byte representation.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Returns the native byte representation.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    /// Returns the ABI byte order expected by VST3 `createInstance` / factory CIDs.
    ///
    /// Component class IDs use COM GUID memory layout on every platform we host
    /// (Windows Steinberg, and cross-platform wrappers such as truce that store
    /// the same little-endian CID bytes in the factory on macOS/Linux). The
    /// canonical string form stays platform-independent by always converting
    /// through this layout.
    #[must_use]
    pub const fn to_tuid(self) -> TUID {
        let bytes = com_guid_bytes(self.0);
        let mut result = [tuid_byte(0); 16];
        let mut index = 0;
        while index < 16 {
            result[index] = tuid_byte(bytes[index]);
            index += 1;
        }
        result
    }

    /// Creates the canonical, platform-independent ID from a VST3 ABI TUID.
    #[must_use]
    pub const fn from_tuid(value: TUID) -> Self {
        let mut bytes = [0_u8; 16];
        let mut index = 0;
        while index < 16 {
            bytes[index] = value[index] as u8;
            index += 1;
        }
        Self(com_guid_bytes(bytes))
    }
}

/// Swaps the first three GUID fields between registry order and COM memory order.
const fn com_guid_bytes(bytes: [u8; 16]) -> [u8; 16] {
    [
        bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6], bytes[8],
        bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    ]
}

impl FromStr for ClassId {
    type Err = HostError;

    fn from_str(value: &str) -> Result<Self, HostError> {
        let compact = value
            .bytes()
            .filter(|byte| !matches!(byte, b'{' | b'}' | b'-'))
            .collect::<Vec<_>>();
        if compact.len() != 32 {
            return Err(HostError::InvalidClassId(value.to_owned()));
        }
        let mut bytes = [0_u8; 16];
        for (index, pair) in compact.as_chunks::<2>().0.iter().enumerate() {
            let text = std::str::from_utf8(pair)
                .map_err(|_| HostError::InvalidClassId(value.to_owned()))?;
            bytes[index] = u8::from_str_radix(text, 16)
                .map_err(|_| HostError::InvalidClassId(value.to_owned()))?;
        }
        Ok(Self(bytes))
    }
}

impl fmt::Debug for ClassId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "ClassId({self})")
    }
}

impl fmt::Display for ClassId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02X}")?;
        }
        Ok(())
    }
}

/// Reads a NUL-terminated Steinberg `char8` buffer as lossy UTF-8.
pub(crate) fn fixed_c_string<const N: usize>(bytes: &[c_char; N]) -> String {
    let length = bytes.iter().position(|value| *value == 0).unwrap_or(N);
    String::from_utf8_lossy(
        &bytes[..length]
            .iter()
            .map(|value| *value as u8)
            .collect::<Vec<_>>(),
    )
    .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_compact_and_registry_ids() {
        let compact: ClassId = "42043F99B7DA453CA569E79D9AAEC33D"
            .parse()
            .expect("compact ID");
        let registry: ClassId = "{42043F99-B7DA-453C-A569-E79D9AAEC33D}"
            .parse()
            .expect("registry ID");

        assert_eq!(compact, registry);
        assert_eq!(compact.to_string(), "42043F99B7DA453CA569E79D9AAEC33D");
    }

    #[test]
    fn rejects_malformed_ids() {
        assert!(matches!(
            "not-an-id".parse::<ClassId>(),
            Err(HostError::InvalidClassId(_))
        ));
    }

    #[test]
    fn target_tuid_round_trips() {
        let id: ClassId = "42043F99B7DA453CA569E79D9AAEC33D"
            .parse()
            .expect("valid ID");
        assert_eq!(ClassId::from_tuid(id.to_tuid()), id);
    }

    #[test]
    fn com_factory_bytes_map_to_registry_class_ids() {
        // truce's vst3_cid() stores FNV-1a as little-endian factory bytes. Those
        // match COM GUID memory order for the registry IDs committed in desktop.
        let factory = [
            0x11, 0x6A, 0xD1, 0x8C, 0x7A, 0x02, 0x7F, 0xCC, 0xDF, 0x0C, 0x14, 0x19, 0xE8, 0x6D,
            0x10, 0x24,
        ];
        let mut tuid = [tuid_byte(0); 16];
        let mut index = 0;
        while index < 16 {
            tuid[index] = tuid_byte(factory[index]);
            index += 1;
        }
        let id = ClassId::from_tuid(tuid);
        assert_eq!(id.to_string(), "8CD16A11027ACC7FDF0C1419E86D1024");
        assert_eq!(
            id.to_tuid()
                .into_iter()
                .map(|byte| byte as u8)
                .collect::<Vec<_>>(),
            factory
        );
    }
}
