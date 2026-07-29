use ara2_bridge_core::{ApiGeneration, AraError, DocumentProperties};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider, AudioSourceId,
    HostAudioReader, HostServices, HostServicesBuilder, LoadedFactory, dispatch_manifest,
};
use ara2_bridge_sys::{ARAAssertCategory, compatibility::DOCUMENT_CONTROLLER_CALLBACKS};
use ara2_bridge_testkit::{TestPluginTrace, build_minimal_test_factory, build_test_factory};
use std::ffi::{c_char, c_void};

struct NoAudio;

impl AudioAccessProvider for NoAudio {
    fn create_reader(
        &self,
        _: AudioSourceId,
        _: bool,
    ) -> Result<Box<dyn HostAudioReader>, AraError> {
        Err(AraError::Peer("no fixture source"))
    }
}

struct EmptyArchive;

impl ArchivingProvider for EmptyArchive {
    fn len(&self, _: ArchiveReaderId) -> Result<usize, AraError> {
        Ok(0)
    }

    fn read_at(&self, _: ArchiveReaderId, _: usize, _: &mut [u8]) -> Result<(), AraError> {
        Ok(())
    }

    fn write_at(&self, _: ArchiveWriterId, _: usize, _: &[u8]) -> Result<(), AraError> {
        Ok(())
    }
}

unsafe extern "C" fn assertion(_: ARAAssertCategory, _: *const c_void, _: *const c_char) {}

fn services() -> HostServices {
    HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .build(ApiGeneration::V23Final)
        .unwrap()
}

#[test]
fn generated_dispatch_matches_all_released_controller_slots() {
    let methods = dispatch_manifest();
    assert_eq!(methods.len(), 54);
    for (index, name) in DOCUMENT_CONTROLLER_CALLBACKS.iter().enumerate() {
        assert_eq!(methods[index].c_name, *name);
        assert_eq!(methods[index].index, index);
        assert!(methods[index].field_extent > methods[index].field_offset);
    }
}

#[test]
fn factory_creates_identity_checked_controller_and_drop_balances_destruction() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: the fixture owns immutable factory backing beyond the loaded guard.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion)) }
            .unwrap();
    let services = services();
    let properties = DocumentProperties::new(Some("Host fixture")).unwrap();
    {
        let controller = loaded
            .create_document_controller(&services, &properties)
            .unwrap();
        assert_eq!(controller.generation(), ApiGeneration::V23Final);
        assert_eq!(controller.factory_ptr(), factory.as_raw());
        assert!(!controller.as_raw_ref().is_null());
        assert!(!controller.interface_ptr().is_null());
        assert_eq!(trace.count("destroy_document"), 0);
    }
    assert_eq!(trace.count("destroy_document"), 1);
}

#[test]
fn absent_processing_capability_uses_zero_count_fallback() {
    let factory = build_minimal_test_factory(TestPluginTrace::new()).unwrap();
    // SAFETY: the fixture owns immutable factory backing beyond the loaded guard.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V2Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .build(ApiGeneration::V2Final)
        .unwrap();
    let properties = DocumentProperties::new(None).unwrap();
    let mut controller = loaded
        .create_document_controller(&services, &properties)
        .unwrap();
    assert_eq!(controller.processing_algorithms_count().unwrap(), 0);
}

#[test]
fn minimal_controller_loads_every_supported_generation_prefix() {
    #[cfg(target_arch = "aarch64")]
    let generations = [
        ApiGeneration::V2Final,
        ApiGeneration::V2xDraft,
        ApiGeneration::V23Final,
    ]
    .as_slice();
    #[cfg(not(target_arch = "aarch64"))]
    let generations = [
        ApiGeneration::V1Draft,
        ApiGeneration::V1Final,
        ApiGeneration::V2Draft,
        ApiGeneration::V2Final,
        ApiGeneration::V2xDraft,
        ApiGeneration::V23Final,
    ]
    .as_slice();

    let factory = build_minimal_test_factory(TestPluginTrace::new()).unwrap();
    let properties = DocumentProperties::new(None).unwrap();
    for generation in generations {
        // SAFETY: the fixture owns immutable backing and each guard is dropped before the next.
        let loaded =
            unsafe { LoadedFactory::load(factory.as_raw(), *generation, Some(assertion)) }.unwrap();
        let services = HostServicesBuilder::new()
            .audio(NoAudio)
            .archiving(EmptyArchive)
            .build(*generation)
            .unwrap();
        let controller = loaded
            .create_document_controller(&services, &properties)
            .unwrap();
        assert_eq!(controller.generation(), *generation);
        drop(controller);
        drop(loaded);
    }
}
