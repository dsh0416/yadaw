use ara2_bridge_core::{
    ApiGeneration, AraError, AudioModificationProperties, ContentUpdateScopes, DocumentProperties,
    MusicalContextProperties, PlaybackRegionProperties, RegionSequenceProperties,
};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider, AudioSourceId,
    ContentAccessProvider, DocumentSession, HostAudioReader, HostContentReaderSnapshot,
    HostServicesBuilder, LoadedFactory, MusicalContextId,
};
use ara2_bridge_sys::ARAAssertCategory;
use ara2_bridge_testkit::{TestPluginTrace, build_test_factory, test_audio_source_properties};
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

struct EmptyContent;

impl ContentAccessProvider for EmptyContent {
    fn musical_context_grade(
        &self,
        _: MusicalContextId,
        _: i32,
    ) -> Result<Option<ara2_bridge_core::ContentGrade>, AraError> {
        Ok(None)
    }

    fn musical_context_reader(
        &self,
        _: MusicalContextId,
        _: i32,
        _: Option<ara2_bridge_core::ContentTimeRange>,
    ) -> Result<Option<HostContentReaderSnapshot>, AraError> {
        Ok(None)
    }

    fn audio_source_grade(
        &self,
        _: AudioSourceId,
        _: i32,
    ) -> Result<Option<ara2_bridge_core::ContentGrade>, AraError> {
        Ok(None)
    }

    fn audio_source_reader(
        &self,
        _: AudioSourceId,
        _: i32,
        _: Option<ara2_bridge_core::ContentTimeRange>,
    ) -> Result<Option<HostContentReaderSnapshot>, AraError> {
        Ok(None)
    }
}

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

#[test]
fn edit_guard_creates_and_destroys_a_stable_musical_context() {
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
    let document = DocumentProperties::new(Some("Graph fixture")).unwrap();
    let mut session = DocumentSession::new(&loaded, &services, document).unwrap_or_else(|error| {
        panic!(
            "document creation failed: {error}; trace={:?}",
            trace.records()
        )
    });

    let mut edit = session.edit().unwrap();
    let context = edit
        .create_musical_context(MusicalContextProperties::new(Some("Song"), 0, None).unwrap())
        .unwrap();
    edit.destroy_musical_context(context).unwrap();
    edit.finish().unwrap();

    assert!(session.musical_context_ref(context).is_err());
    assert_eq!(trace.count("begin_editing"), 1);
    assert_eq!(trace.count("create_musical_context"), 1);
    assert_eq!(trace.count("end_editing"), 1);
    assert!(!session.is_poisoned());
}

#[test]
fn dropping_an_unfinished_edit_guard_balances_end_editing() {
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
    drop(session.edit().unwrap());
    assert_eq!(trace.count("begin_editing"), 1);
    assert_eq!(trace.count("end_editing"), 1);
}

#[test]
fn failed_create_after_reentrant_host_callback_quarantines_the_session() {
    let trace = TestPluginTrace::new();
    trace.reject_next_audio_source_after_host_callback();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and session.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .content(EmptyContent)
        .build(ApiGeneration::V23Final)
        .unwrap();
    let mut session =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();

    let mut edit = session.edit().unwrap();
    let result = edit.create_audio_source(test_audio_source_properties().unwrap());
    assert!(result.is_err());
    edit.finish().unwrap();

    assert!(session.is_poisoned());
    assert!(session.edit().is_err());
    let close = session.close().unwrap_err();
    assert_eq!(close.failures().len(), 1);
    assert_eq!(close.failures()[0].operation(), "begin editing");
    assert_eq!(trace.count("destroy_document"), 1);
}

#[test]
fn ara2_graph_creates_and_destroys_every_object_leaf_first() {
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
    let mut session = DocumentSession::new(
        &loaded,
        &services,
        DocumentProperties::new(Some("Complete graph")).unwrap(),
    )
    .unwrap();

    let mut edit = session.edit().unwrap();
    let context = edit
        .create_musical_context(MusicalContextProperties::new(Some("Song"), 0, None).unwrap())
        .unwrap();
    let context_ref = edit.musical_context_ref(context).unwrap();
    let sequence = edit
        .create_region_sequence(
            RegionSequenceProperties::new(Some("Verse"), 0, context_ref, None).unwrap(),
        )
        .unwrap();
    let source = edit
        .create_audio_source(test_audio_source_properties().unwrap())
        .unwrap();
    let modification = edit
        .create_audio_modification(
            source,
            AudioModificationProperties::new(Some("Main"), "test.modification").unwrap(),
        )
        .unwrap();
    let sequence_ref = edit.region_sequence_ref(sequence).unwrap();
    let region = edit
        .create_playback_region(
            modification,
            PlaybackRegionProperties::for_ara2(
                0,
                0.0,
                1.0,
                0.0,
                1.0,
                sequence_ref,
                Some("Region"),
                None,
            )
            .unwrap(),
        )
        .unwrap();

    assert!(edit.destroy_audio_source(source).is_err());
    assert!(edit.destroy_region_sequence(sequence).is_err());
    edit.destroy_playback_region(region).unwrap();
    edit.destroy_audio_modification(modification).unwrap();
    edit.destroy_audio_source(source).unwrap();
    edit.destroy_region_sequence(sequence).unwrap();
    edit.destroy_musical_context(context).unwrap();
    edit.finish().unwrap();

    assert_eq!(trace.count("create_musical_context"), 1);
    assert_eq!(trace.count("create_region_sequence"), 1);
    assert_eq!(trace.count("create_audio_source"), 1);
    assert_eq!(trace.count("create_audio_modification"), 1);
    assert_eq!(trace.count("create_playback_region"), 1);
}

#[test]
fn explicit_close_destroys_a_live_graph_leaf_first() {
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
    let context = edit
        .create_musical_context(MusicalContextProperties::new(Some("Song"), 0, None).unwrap())
        .unwrap();
    let sequence = edit
        .create_region_sequence(
            RegionSequenceProperties::new(
                Some("Verse"),
                0,
                edit.musical_context_ref(context).unwrap(),
                None,
            )
            .unwrap(),
        )
        .unwrap();
    let source = edit
        .create_audio_source(test_audio_source_properties().unwrap())
        .unwrap();
    let modification = edit
        .create_audio_modification(
            source,
            AudioModificationProperties::new(None, "test.modification").unwrap(),
        )
        .unwrap();
    edit.create_playback_region(
        modification,
        PlaybackRegionProperties::for_ara2(
            0,
            0.0,
            1.0,
            0.0,
            1.0,
            edit.region_sequence_ref(sequence).unwrap(),
            None,
            None,
        )
        .unwrap(),
    )
    .unwrap();
    edit.finish().unwrap();

    session.close().unwrap();

    let teardown = trace
        .records()
        .into_iter()
        .filter(|record| record.starts_with("destroy_"))
        .collect::<Vec<_>>();
    assert_eq!(
        teardown,
        [
            "destroy_playback_region",
            "destroy_audio_modification",
            "destroy_audio_source",
            "destroy_region_sequence",
            "destroy_musical_context",
            "destroy_document",
        ]
    );
}

#[test]
fn graph_updates_clones_and_deactivation_preserve_local_invariants() {
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
    edit.update_document_properties(DocumentProperties::new(Some("Updated")).unwrap())
        .unwrap();
    let context = edit
        .create_musical_context(MusicalContextProperties::new(Some("Song"), 0, None).unwrap())
        .unwrap();
    let context_ref = edit.musical_context_ref(context).unwrap();
    let sequence = edit
        .create_region_sequence(
            RegionSequenceProperties::new(Some("Verse"), 0, context_ref, None).unwrap(),
        )
        .unwrap();
    let source = edit
        .create_audio_source(test_audio_source_properties().unwrap())
        .unwrap();
    let duplicate = edit.create_audio_modification(
        source,
        AudioModificationProperties::new(None, "test-source").unwrap(),
    );
    assert!(matches!(duplicate, Err(AraError::InvalidArgument(_))));
    assert_eq!(trace.count("create_audio_modification"), 0);

    let modification = edit
        .create_audio_modification(
            source,
            AudioModificationProperties::new(Some("Main"), "test.modification").unwrap(),
        )
        .unwrap();
    let clone = edit
        .clone_audio_modification(
            modification,
            AudioModificationProperties::new(Some("Clone"), "test.clone").unwrap(),
        )
        .unwrap();
    let sequence_ref = edit.region_sequence_ref(sequence).unwrap();
    let region_properties =
        PlaybackRegionProperties::for_ara2(0, 0.0, 1.0, 0.0, 1.0, sequence_ref, None, None)
            .unwrap();
    let region = edit
        .create_playback_region(modification, region_properties.clone())
        .unwrap();

    edit.update_musical_context(
        context,
        MusicalContextProperties::new(Some("Updated Song"), 1, None).unwrap(),
    )
    .unwrap();
    edit.update_musical_context_content(context, None, ContentUpdateScopes::empty())
        .unwrap();
    edit.update_region_sequence(
        sequence,
        RegionSequenceProperties::new(Some("Updated Verse"), 1, context_ref, None).unwrap(),
    )
    .unwrap();
    edit.update_audio_source(source, test_audio_source_properties().unwrap())
        .unwrap();
    edit.update_audio_source_content(source, None, ContentUpdateScopes::empty())
        .unwrap();
    edit.update_audio_modification(
        modification,
        AudioModificationProperties::new(Some("Updated Main"), "test.modification").unwrap(),
    )
    .unwrap();
    edit.update_playback_region(region, region_properties)
        .unwrap();
    edit.set_audio_source_samples_access(source, true).unwrap();
    edit.set_audio_source_samples_access(source, false).unwrap();
    assert!(edit.set_audio_source_deactivated(source, true).is_err());
    assert!(
        edit.set_audio_modification_deactivated(modification, true)
            .is_err()
    );
    edit.destroy_playback_region(region).unwrap();
    edit.set_audio_modification_deactivated(modification, true)
        .unwrap();
    edit.set_audio_modification_deactivated(clone, true)
        .unwrap();
    edit.set_audio_source_deactivated(source, true).unwrap();
    edit.set_audio_source_deactivated(source, false).unwrap();
    edit.set_audio_modification_deactivated(modification, false)
        .unwrap();
    edit.set_audio_modification_deactivated(clone, false)
        .unwrap();

    edit.destroy_audio_modification(clone).unwrap();
    edit.destroy_audio_modification(modification).unwrap();
    edit.destroy_audio_source(source).unwrap();
    edit.destroy_region_sequence(sequence).unwrap();
    edit.destroy_musical_context(context).unwrap();
    edit.finish().unwrap();

    assert_eq!(trace.count("update_document"), 1);
    assert_eq!(trace.count("clone_audio_modification"), 1);
    assert_eq!(trace.count("update_musical_context"), 1);
    assert_eq!(trace.count("update_musical_context_content"), 1);
    assert_eq!(trace.count("update_region_sequence"), 1);
    assert_eq!(trace.count("update_audio_source"), 1);
    assert_eq!(trace.count("update_audio_source_content"), 1);
    assert_eq!(trace.count("update_audio_modification"), 1);
    assert_eq!(trace.count("update_playback_region"), 1);
    assert_eq!(trace.count("deactivate_audio_source"), 1);
    assert_eq!(trace.count("reactivate_audio_source"), 1);
    assert_eq!(trace.count("deactivate_audio_modification"), 2);
    assert_eq!(trace.count("reactivate_audio_modification"), 2);
}

#[test]
#[cfg(not(target_arch = "aarch64"))]
fn ara1_playback_regions_translate_context_refs_to_the_peer_graph() {
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
    let mut edit = session.edit().unwrap();
    let context = edit
        .create_musical_context(MusicalContextProperties::new(Some("Legacy"), 0, None).unwrap())
        .unwrap();
    let source = edit
        .create_audio_source(test_audio_source_properties().unwrap())
        .unwrap();
    let modification = edit
        .create_audio_modification(
            source,
            AudioModificationProperties::new(None, "legacy-modification").unwrap(),
        )
        .unwrap();
    let region = edit
        .create_playback_region(
            modification,
            PlaybackRegionProperties::for_ara1(
                0,
                0.0,
                1.0,
                0.0,
                1.0,
                edit.musical_context_ref(context).unwrap(),
                None,
                None,
            )
            .unwrap(),
        )
        .unwrap();
    edit.destroy_playback_region(region).unwrap();
    edit.destroy_audio_modification(modification).unwrap();
    edit.destroy_audio_source(source).unwrap();
    edit.destroy_musical_context(context).unwrap();
    edit.finish().unwrap();

    assert_eq!(trace.count("create_region_sequence"), 1);
    assert_eq!(trace.count("create_playback_region"), 1);
}

#[test]
fn sample_access_can_be_changed_outside_an_edit_scope() {
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
    let source = {
        let mut edit = session.edit().unwrap();
        let source = edit
            .create_audio_source(test_audio_source_properties().unwrap())
            .unwrap();
        edit.finish().unwrap();
        source
    };

    session
        .set_audio_source_samples_access(source, true)
        .unwrap();
    session
        .set_audio_source_samples_access(source, false)
        .unwrap();

    let mut edit = session.edit().unwrap();
    edit.destroy_audio_source(source).unwrap();
    edit.finish().unwrap();
    assert_eq!(trace.count("enable_audio_source"), 1);
    assert_eq!(trace.count("disable_audio_source"), 1);
}

#[test]
fn graph_rejects_a_reference_from_another_document_before_ffi() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace.clone()).unwrap();
    // SAFETY: fixture backing outlives the initialized guard and both sessions.
    let loaded =
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion)) }
            .unwrap();
    let services = HostServicesBuilder::new()
        .audio(NoAudio)
        .archiving(EmptyArchive)
        .build(ApiGeneration::V23Final)
        .unwrap();
    let mut first =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();
    let context = {
        let mut edit = first.edit().unwrap();
        let context = edit
            .create_musical_context(MusicalContextProperties::new(None, 0, None).unwrap())
            .unwrap();
        edit.finish().unwrap();
        context
    };
    let foreign_ref = first.musical_context_ref(context).unwrap();
    let mut second =
        DocumentSession::new(&loaded, &services, DocumentProperties::new(None).unwrap()).unwrap();
    let mut edit = second.edit().unwrap();
    let result = edit
        .create_region_sequence(RegionSequenceProperties::new(None, 0, foreign_ref, None).unwrap());
    assert!(matches!(result, Err(AraError::InvalidArgument(_))));
    edit.finish().unwrap();
    assert_eq!(trace.count("create_region_sequence"), 0);

    let mut edit = first.edit().unwrap();
    edit.destroy_musical_context(context).unwrap();
    edit.finish().unwrap();
}
