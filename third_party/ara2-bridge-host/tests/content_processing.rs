use ara2_bridge_core::{
    ApiGeneration, AraError, AudioModificationProperties, ContentGrade, ContentKind,
    DocumentProperties, LicenseRequest, Notes, PlaybackTransformationFlags,
};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider, AudioSourceId,
    DocumentSession, HostAudioReader, HostServicesBuilder, LoadedFactory, ModelUpdateProvider,
};
use ara2_bridge_sys::ARAAssertCategory;
use ara2_bridge_testkit::{TestPluginTrace, build_test_factory, test_audio_source_properties};
use std::ffi::{c_char, c_void};
use std::sync::atomic::AtomicU8;
use std::sync::{Arc, Mutex};

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

#[derive(Clone, Default)]
struct Updates(Arc<Mutex<Vec<(i32, f32)>>>);

impl ModelUpdateProvider for Updates {
    fn audio_source_analysis_progress(
        &self,
        _: AudioSourceId,
        state: i32,
        value: f32,
    ) -> Result<(), AraError> {
        self.0.lock().unwrap().push((state, value));
        Ok(())
    }
}

unsafe extern "C" fn assertion(_: ARAAssertCategory, _: *const c_void, _: *const c_char) {}

static CHUNK_WRITER: AtomicU8 = AtomicU8::new(0);

#[test]
fn typed_content_analysis_and_reader_round_trip_through_the_host_facade() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and session.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion)) }
            .unwrap();
    let updates = Updates::default();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .model_updates(updates.clone())
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

    assert!(
        session
            .audio_source_content_available::<Notes>(source)
            .unwrap()
    );
    assert_eq!(
        session.audio_source_content_grade::<Notes>(source).unwrap(),
        ContentGrade::APPROVED
    );
    session
        .request_audio_source_content_analysis::<Notes>(source)
        .unwrap();
    session.notify_model_updates().unwrap();
    assert_eq!(trace.count("request_analysis"), 1);
    assert_eq!(updates.0.lock().unwrap().len(), 3);

    let mut reader = session
        .audio_source_content_reader::<Notes>(source, None)
        .unwrap()
        .unwrap();
    assert_eq!(reader.len(), 1);
    assert_eq!(reader.event(0).unwrap().frequency(), Some(440.0));
    drop(reader);

    let algorithms = session.processing_algorithms().unwrap();
    assert_eq!(algorithms.len(), 2);
    assert_eq!(algorithms[1].persistent_id(), "test.polyphonic");
    assert_eq!(
        session
            .processing_algorithm_for_audio_source(source)
            .unwrap(),
        0
    );
    let mut edit = session.edit().unwrap();
    edit.request_processing_algorithm(source, 1).unwrap();
    edit.finish().unwrap();
    assert_eq!(
        session
            .processing_algorithm_for_audio_source(source)
            .unwrap(),
        1
    );

    let capabilities = session.license_capabilities().unwrap();
    let request = LicenseRequest::new(
        false,
        [Notes::RAW_TYPE],
        PlaybackTransformationFlags::empty(),
        &capabilities,
    )
    .unwrap();
    assert!(session.is_licensed_for_capabilities(&request).unwrap());
    assert!(
        session
            .audio_modification_preserves_source_signal(modification)
            .unwrap()
    );
    let chunk = session
        .store_audio_source_to_audio_file_chunk(&CHUNK_WRITER, source)
        .unwrap();
    assert_eq!(chunk.document_archive_id(), "org.ara2-bridge.test.archive");
    assert!(chunk.open_automatically());

    session.close().unwrap();
}
