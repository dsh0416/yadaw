//! Target-specific VST3 interface identifiers.

use crate::{Steinberg::TUID, compat::tuid_byte};

#[cfg(windows)]
const fn tuid(a: u32, b: u32, c: u32, d: u32) -> TUID {
    [
        tuid_byte((a & 0xff) as u8),
        tuid_byte(((a >> 8) & 0xff) as u8),
        tuid_byte(((a >> 16) & 0xff) as u8),
        tuid_byte(((a >> 24) & 0xff) as u8),
        tuid_byte(((b >> 16) & 0xff) as u8),
        tuid_byte(((b >> 24) & 0xff) as u8),
        tuid_byte((b & 0xff) as u8),
        tuid_byte(((b >> 8) & 0xff) as u8),
        tuid_byte(((c >> 24) & 0xff) as u8),
        tuid_byte(((c >> 16) & 0xff) as u8),
        tuid_byte(((c >> 8) & 0xff) as u8),
        tuid_byte((c & 0xff) as u8),
        tuid_byte(((d >> 24) & 0xff) as u8),
        tuid_byte(((d >> 16) & 0xff) as u8),
        tuid_byte(((d >> 8) & 0xff) as u8),
        tuid_byte((d & 0xff) as u8),
    ]
}

#[cfg(not(windows))]
const fn tuid(a: u32, b: u32, c: u32, d: u32) -> TUID {
    [
        tuid_byte(((a >> 24) & 0xff) as u8),
        tuid_byte(((a >> 16) & 0xff) as u8),
        tuid_byte(((a >> 8) & 0xff) as u8),
        tuid_byte((a & 0xff) as u8),
        tuid_byte(((b >> 24) & 0xff) as u8),
        tuid_byte(((b >> 16) & 0xff) as u8),
        tuid_byte(((b >> 8) & 0xff) as u8),
        tuid_byte((b & 0xff) as u8),
        tuid_byte(((c >> 24) & 0xff) as u8),
        tuid_byte(((c >> 16) & 0xff) as u8),
        tuid_byte(((c >> 8) & 0xff) as u8),
        tuid_byte((c & 0xff) as u8),
        tuid_byte(((d >> 24) & 0xff) as u8),
        tuid_byte(((d >> 16) & 0xff) as u8),
        tuid_byte(((d >> 8) & 0xff) as u8),
        tuid_byte((d & 0xff) as u8),
    ]
}

pub const FUNKNOWN: TUID = tuid(0x00000000, 0x00000000, 0xC0000000, 0x00000046);
pub const IPLUGIN_BASE: TUID = tuid(0x22888DDB, 0x156E45AE, 0x8358B348, 0x08190625);
pub const IPLUGIN_FACTORY: TUID = tuid(0x7A4D811C, 0x52114A1F, 0xAED9D2EE, 0x0B43BF9F);
pub const IPLUGIN_FACTORY2: TUID = tuid(0x0007B650, 0xF24B4C0B, 0xA464EDB9, 0xF00B2ABB);
pub const IPLUGIN_FACTORY3: TUID = tuid(0x4555A2AB, 0xC1234E57, 0x9B122910, 0x36878931);
pub const IBSTREAM: TUID = tuid(0xC3BF6EA2, 0x30994752, 0x9B6BF990, 0x1EE33E9B);
pub const IHOST_APPLICATION: TUID = tuid(0x58E595CC, 0xDB2D4969, 0x8B6AAF8C, 0x36A664E5);
pub const IPLUG_INTERFACE_SUPPORT: TUID = tuid(0x4FB58B9E, 0x9EAA4E0F, 0xAB361C1C, 0xCCB56FEA);
pub const IMESSAGE: TUID = tuid(0x936F033B, 0xC6C047DB, 0xBB0882F8, 0x13C1E613);
pub const IATTRIBUTE_LIST: TUID = tuid(0x1E5F0AEB, 0xCC7F4533, 0xA2544011, 0x38AD5EE4);
pub const ICOMPONENT: TUID = tuid(0xE831FF31, 0xF2D54301, 0x928EBBEE, 0x25697802);
pub const IAUDIO_PROCESSOR: TUID = tuid(0x42043F99, 0xB7DA453C, 0xA569E79D, 0x9AAEC33D);
pub const IPROCESS_CONTEXT_REQUIREMENTS: TUID =
    tuid(0x2A654303, 0xEF764E3D, 0x95B5FE83, 0x730EF6D0);
pub const IEDIT_CONTROLLER: TUID = tuid(0xDCD7BBE3, 0x7742448D, 0xA874AACC, 0x979C759E);
pub const IMIDI_MAPPING: TUID = tuid(0xDF0FF9F7, 0x49B74669, 0xB63AB732, 0x7ADBF5E5);
pub const ICOMPONENT_HANDLER: TUID = tuid(0x93A0BEA3, 0x0BD045DB, 0x8E890B0C, 0xC1E46AC6);
pub const IEVENT_LIST: TUID = tuid(0x3A2C4214, 0x346349FE, 0xB2C4F397, 0xB9695A44);
pub const IPARAMETER_CHANGES: TUID = tuid(0xA4779663, 0x0BB64A56, 0xB44384A8, 0x466FEB9D);
pub const IPARAM_VALUE_QUEUE: TUID = tuid(0x01263A18, 0xED074F6F, 0x98C9D356, 0x4686F9BA);
pub const ICONNECTION_POINT: TUID = tuid(0x70A4156F, 0x6E6E4026, 0x989148BF, 0xAA60D8D1);
pub const IPLUG_VIEW: TUID = tuid(0x5BC32507, 0xD06049EA, 0xA6151B52, 0x2B755B29);
pub const IPLUG_FRAME: TUID = tuid(0x367FAF01, 0xAFA94693, 0x8D4DA2A0, 0xED0882A3);
pub const IPLUG_VIEW_CONTENT_SCALE_SUPPORT: TUID =
    tuid(0x65ED9690, 0x8AC44525, 0x8AADEF7A, 0x72EA703F);
pub const IEVENT_HANDLER: TUID = tuid(0x561E65C9, 0x13A0496F, 0x813A2C35, 0x654D7983);
pub const ITIMER_HANDLER: TUID = tuid(0x10BDD94F, 0x41424774, 0x821FAD8F, 0xECA72CA9);
pub const IRUN_LOOP: TUID = tuid(0x18C35366, 0x97764F1A, 0x9C5B8385, 0x7A871389);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interface_ids_have_sixteen_bytes() {
        assert_eq!(FUNKNOWN.len(), 16);
        assert_eq!(IAUDIO_PROCESSOR.len(), 16);
        assert_ne!(ICOMPONENT, IAUDIO_PROCESSOR);
    }
}
