use ara2_bridge_core::{ApiGeneration, AraError};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider, AudioSourceId,
    HostAudioReader, HostServicesBuilder,
};
use ara2_bridge_sys::kARAFalse;
use ara2_bridge_sys::{
    ARAArchiveReaderHostRef, ARAArchivingControllerHostRef, ARAArchivingControllerInterface,
    ARASize, access::read_field,
};
use std::mem::{offset_of, size_of};

struct SilentAudio;

impl AudioAccessProvider for SilentAudio {
    fn create_reader(
        &self,
        _: AudioSourceId,
        _: bool,
    ) -> Result<Box<dyn HostAudioReader>, AraError> {
        Err(AraError::Peer("fixture has no audio source"))
    }
}

#[derive(Default)]
struct EmptyArchives {
    panic_on_size: bool,
}

impl ArchivingProvider for EmptyArchives {
    fn len(&self, _: ArchiveReaderId) -> Result<usize, AraError> {
        assert!(!self.panic_on_size, "injected archive panic");
        Ok(0)
    }

    fn read_at(&self, _: ArchiveReaderId, _: usize, _: &mut [u8]) -> Result<(), AraError> {
        Ok(())
    }

    fn write_at(&self, _: ArchiveWriterId, _: usize, _: &[u8]) -> Result<(), AraError> {
        Ok(())
    }
}

#[test]
fn required_services_are_stable_and_optional_services_are_absent() {
    assert!(
        HostServicesBuilder::new()
            .build(ApiGeneration::V23Final)
            .is_err()
    );

    let services = HostServicesBuilder::new()
        .audio(SilentAudio)
        .archiving(EmptyArchives::default())
        .build(ApiGeneration::V23Final)
        .unwrap();
    let instance = services.instance();
    assert!(!instance.audioAccessControllerHostRef.is_null());
    assert!(!instance.audioAccessControllerInterface.is_null());
    assert!(!instance.archivingControllerHostRef.is_null());
    assert!(!instance.archivingControllerInterface.is_null());
    assert!(instance.contentAccessControllerHostRef.is_null());
    assert!(instance.contentAccessControllerInterface.is_null());
    assert!(instance.modelUpdateControllerHostRef.is_null());
    assert!(instance.modelUpdateControllerInterface.is_null());
    assert!(instance.playbackControllerHostRef.is_null());
    assert!(instance.playbackControllerInterface.is_null());
    assert_eq!(services.instance_ptr(), services.instance_ptr());
    // SAFETY: the service object owns the advertised packed interface for its full lifetime.
    let archive_size = unsafe {
        read_field::<ARASize>(
            instance.archivingControllerInterface.cast(),
            offset_of!(ARAArchivingControllerInterface, structSize),
        )
    };
    // SAFETY: same live packed interface and exact callback field offset.
    let archive_id = unsafe {
        read_field::<
            Option<
                unsafe extern "C" fn(
                    ARAArchivingControllerHostRef,
                    ARAArchiveReaderHostRef,
                ) -> ara2_bridge_sys::ARAPersistentID,
            >,
        >(
            instance.archivingControllerInterface.cast(),
            offset_of!(ARAArchivingControllerInterface, getDocumentArchiveID),
        )
    };
    assert_eq!(archive_size, size_of::<ARAArchivingControllerInterface>());
    assert!(archive_id.is_some());
}

#[test]
#[cfg(not(target_arch = "aarch64"))]
fn legacy_archive_prefix_omits_the_ara2_archive_id_tail() {
    let services = HostServicesBuilder::new()
        .audio(SilentAudio)
        .archiving(EmptyArchives::default())
        .build(ApiGeneration::V1Final)
        .unwrap();
    // SAFETY: the service object owns the advertised packed interface for its full lifetime.
    let archive_size = unsafe {
        read_field::<ARASize>(
            services.instance().archivingControllerInterface.cast(),
            offset_of!(ARAArchivingControllerInterface, structSize),
        )
    };
    assert!(archive_size < size_of::<ARAArchivingControllerInterface>());
}

#[test]
fn a_panicking_service_quarantines_only_its_document() {
    let bad = HostServicesBuilder::new()
        .audio(SilentAudio)
        .archiving(EmptyArchives {
            panic_on_size: true,
        })
        .build(ApiGeneration::V23Final)
        .unwrap();
    let good = HostServicesBuilder::new()
        .audio(SilentAudio)
        .archiving(EmptyArchives::default())
        .build(ApiGeneration::V23Final)
        .unwrap();

    // SAFETY: both callbacks and references are owned by their respective live service objects.
    unsafe {
        let bad_instance = bad.instance();
        let callback = read_field::<
            Option<
                unsafe extern "C" fn(
                    ARAArchivingControllerHostRef,
                    ARAArchiveReaderHostRef,
                ) -> ARASize,
            >,
        >(
            bad_instance.archivingControllerInterface.cast(),
            offset_of!(ARAArchivingControllerInterface, getArchiveSize),
        )
        .unwrap();
        assert_eq!(
            callback(
                bad_instance.archivingControllerHostRef,
                std::ptr::null_mut(),
            ),
            0
        );
    }
    assert!(bad.is_poisoned());
    assert!(!good.is_poisoned());
    assert_eq!(kARAFalse, 0);
}
