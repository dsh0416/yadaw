use ara2_bridge_core::{
    ApiGeneration, AraError, AudioModificationProperties, DocumentProperties, RestoreFilter,
};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider, AudioSourceId,
    DocumentSession, HostAudioReader, HostServicesBuilder, LoadedFactory,
};
use ara2_bridge_sys::ARAAssertCategory;
use ara2_bridge_testkit::{TestPluginTrace, build_test_factory, test_audio_source_properties};
use std::ffi::{c_char, c_void};
use std::sync::atomic::AtomicU8;

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

    fn document_archive_id(&self, _: ArchiveReaderId) -> Result<Option<String>, AraError> {
        Ok(Some("org.ara2-bridge.test.archive".to_owned()))
    }
}

struct IncompatibleArchive;

impl ArchivingProvider for IncompatibleArchive {
    fn len(&self, _: ArchiveReaderId) -> Result<usize, AraError> {
        Ok(0)
    }

    fn read_at(&self, _: ArchiveReaderId, _: usize, _: &mut [u8]) -> Result<(), AraError> {
        Ok(())
    }

    fn write_at(&self, _: ArchiveWriterId, _: usize, _: &[u8]) -> Result<(), AraError> {
        Ok(())
    }

    fn document_archive_id(&self, _: ArchiveReaderId) -> Result<Option<String>, AraError> {
        Ok(Some("org.ara2-bridge.incompatible.archive".to_owned()))
    }
}

unsafe extern "C" fn assertion(_: ARAAssertCategory, _: *const c_void, _: *const c_char) {}

static FIRST_ARCHIVE: AtomicU8 = AtomicU8::new(0);
static SECOND_ARCHIVE: AtomicU8 = AtomicU8::new(0);
static ARCHIVE_WRITER: AtomicU8 = AtomicU8::new(0);

#[test]
fn ara2_restore_accepts_multiple_partial_archives_in_one_edit() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and session.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .build(ApiGeneration::V23Final)
        .unwrap();
    let mut session =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();

    let mut edit = session.edit().unwrap();
    edit.restore_objects_from_archive(&FIRST_ARCHIVE, None)
        .unwrap();
    edit.restore_objects_from_archive(&SECOND_ARCHIVE, None)
        .unwrap();
    edit.finish().unwrap();

    assert_eq!(trace.count("begin_editing"), 1);
    assert_eq!(trace.count("restore_objects"), 2);
    assert_eq!(trace.count("end_editing"), 1);
}

#[test]
fn ara2_restore_rejects_incompatible_archive_before_plugin_dispatch() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and session.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(IncompatibleArchive)
        .build(ApiGeneration::V23Final)
        .unwrap();
    let mut session =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();

    let mut edit = session.edit().unwrap();
    let error = edit
        .restore_objects_from_archive(&FIRST_ARCHIVE, None)
        .unwrap_err();
    edit.finish().unwrap();

    assert!(matches!(error, AraError::InvalidArgument(_)));
    assert_eq!(trace.count("restore_objects"), 0);
}

#[test]
#[cfg(not(target_arch = "aarch64"))]
fn ara1_restore_uses_the_balanced_legacy_scope() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and session.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V1Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .build(ApiGeneration::V1Final)
        .unwrap();
    let mut session =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();

    let restore = session
        .restore_document_from_archive(&FIRST_ARCHIVE)
        .unwrap();
    restore.finish().unwrap();

    assert_eq!(trace.count("restore_document"), 1);
    assert_eq!(trace.count("begin_editing"), 1);
    assert_eq!(trace.count("end_editing"), 1);
}

#[test]
fn split_restore_applies_graph_before_document_data() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and session.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .build(ApiGeneration::V23Final)
        .unwrap();
    let mut session =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();
    let source_filter = RestoreFilter::builder()
        .audio_source("archive-source", "test-source")
        .build()
        .unwrap();
    let modification_filter = RestoreFilter::builder()
        .audio_modification("archive-modification", "test.modification")
        .build()
        .unwrap();
    let document_filter = RestoreFilter::builder()
        .document_data(true)
        .build()
        .unwrap();

    let mut edit = session.edit().unwrap();
    let source = edit
        .create_audio_source(test_audio_source_properties().unwrap())
        .unwrap();
    let modification = edit
        .create_audio_modification(
            source,
            AudioModificationProperties::new(None, "test.modification").unwrap(),
        )
        .unwrap();
    edit.restore_objects_from_archive(&FIRST_ARCHIVE, Some(&source_filter))
        .unwrap();
    edit.restore_objects_from_archive(&FIRST_ARCHIVE, Some(&modification_filter))
        .unwrap();
    edit.restore_objects_from_archive(&SECOND_ARCHIVE, Some(&document_filter))
        .unwrap();
    edit.destroy_audio_modification(modification).unwrap();
    edit.destroy_audio_source(source).unwrap();
    edit.finish().unwrap();

    let records = trace.records();
    let sources = records
        .iter()
        .position(|entry| *entry == "restore_audio_sources")
        .unwrap();
    let modifications = records
        .iter()
        .position(|entry| *entry == "restore_audio_modifications")
        .unwrap();
    let document = records
        .iter()
        .position(|entry| *entry == "restore_document_data")
        .unwrap();
    assert!(sources < modifications && modifications < document);
    assert_eq!(trace.count("begin_editing"), 1);
    assert_eq!(trace.count("end_editing"), 1);
}

#[test]
fn ara2_partial_store_serializes_checked_peer_references_outside_editing() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and session.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .build(ApiGeneration::V23Final)
        .unwrap();
    let mut session =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();
    let (source, modification) = {
        let mut edit = session.edit().unwrap();
        let source = edit
            .create_audio_source(test_audio_source_properties().unwrap())
            .unwrap();
        let modification = edit
            .create_audio_modification(
                source,
                AudioModificationProperties::new(None, "test.modification").unwrap(),
            )
            .unwrap();
        edit.finish().unwrap();
        (source, modification)
    };
    let filter = session
        .store_filter_builder()
        .document_data(true)
        .audio_source(source)
        .audio_modification(modification)
        .build()
        .unwrap();

    session
        .store_objects_to_archive(&ARCHIVE_WRITER, Some(&filter))
        .unwrap();

    let mut edit = session.edit().unwrap();
    edit.destroy_audio_modification(modification).unwrap();
    edit.destroy_audio_source(source).unwrap();
    edit.finish().unwrap();
    assert_eq!(trace.count("store_objects"), 1);
}

#[test]
#[cfg(not(target_arch = "aarch64"))]
fn legacy_store_uses_the_full_document_callback() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and session.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V1Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .build(ApiGeneration::V1Final)
        .unwrap();
    let mut session =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();

    session.store_document_to_archive(&ARCHIVE_WRITER).unwrap();

    assert_eq!(trace.count("store_document"), 1);
}
