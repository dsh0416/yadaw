use std::{fmt, str::FromStr};

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

    /// Returns the target ABI byte order expected by VST3 interface calls.
    #[must_use]
    pub const fn to_tuid(self) -> [i8; 16] {
        #[cfg(windows)]
        let bytes = [
            self.0[3], self.0[2], self.0[1], self.0[0], self.0[5], self.0[4], self.0[7], self.0[6],
            self.0[8], self.0[9], self.0[10], self.0[11], self.0[12], self.0[13], self.0[14],
            self.0[15],
        ];
        #[cfg(not(windows))]
        let bytes = self.0;
        let mut result = [0_i8; 16];
        let mut index = 0;
        while index < 16 {
            result[index] = bytes[index] as i8;
            index += 1;
        }
        result
    }

    /// Creates the canonical, platform-independent ID from a VST3 ABI TUID.
    #[must_use]
    pub const fn from_tuid(value: [i8; 16]) -> Self {
        let mut bytes = [0_u8; 16];
        let mut index = 0;
        while index < 16 {
            bytes[index] = value[index] as u8;
            index += 1;
        }
        #[cfg(windows)]
        let bytes = [
            bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
        ];
        Self(bytes)
    }
}

impl FromStr for ClassId {
    type Err = HostError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let compact = value
            .bytes()
            .filter(|byte| !matches!(byte, b'{' | b'}' | b'-'))
            .collect::<Vec<_>>();
        if compact.len() != 32 {
            return Err(HostError::InvalidClassId(value.to_owned()));
        }
        let mut bytes = [0_u8; 16];
        for (index, pair) in compact.chunks_exact(2).enumerate() {
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
}
