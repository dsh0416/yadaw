use ara2_bridge_core::{
    ApiGeneration, AraError, AudioModificationProperties, ContentTimeRange, DocumentProperties,
    MusicalContextProperties, PlaybackRegionProperties, RegionSequenceProperties,
};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider, AudioSourceId,
    DocumentSession, ExtensionRoles, HostAudioReader, HostServicesBuilder, LoadedFactory,
    RendererRole,
};
use ara2_bridge_sys::ARAAssertCategory;
use ara2_bridge_testkit::{
    TestPluginTrace, build_test_extension, build_test_factory, test_audio_source_properties,
};
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

#[test]
fn role_sets_are_validated_against_returned_interface_pairs() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace).unwrap();
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
    let all = ExtensionRoles::all();
    let (binding, lease) = build_test_extension(ApiGeneration::V23Final, 0, 0).unwrap();

    // SAFETY: the fixture owners retain all extension backing for these synchronous binds.
    let invalid_subset = unsafe {
        session.bind_extension(
            binding.as_raw(),
            ExtensionRoles::PLAYBACK_RENDERER,
            ExtensionRoles::EDITOR_RENDERER,
        )
    };
    assert!(matches!(invalid_subset, Err(AraError::InvalidArgument(_))));

    // The fixture exposes all unknown roles, which conflicts with claiming they were known but
    // unassigned at the companion boundary.
    // SAFETY: same stable fixture backing.
    let inconsistent =
        unsafe { session.bind_extension(binding.as_raw(), all, ExtensionRoles::empty()) };
    assert!(matches!(inconsistent, Err(AraError::Abi(_))));

    session.close().unwrap();
    drop(binding);
    lease.destroy();
}

#[test]
fn ara2_roles_assign_graph_objects_and_copy_view_state() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace).unwrap();
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
    let (sequence, region) = {
        let mut edit = session.edit().unwrap();
        let context = edit
            .create_musical_context(MusicalContextProperties::new(None, 0, None).unwrap())
            .unwrap();
        let sequence = edit
            .create_region_sequence(
                RegionSequenceProperties::new(
                    None,
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
        let region = edit
            .create_playback_region(
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
        (sequence, region)
    };
    let roles = ExtensionRoles::all();
    let (binding, controller_lease) =
        build_test_extension(ApiGeneration::V23Final, roles.bits(), roles.bits()).unwrap();
    // SAFETY: the fixture binding and controller lease retain every published interface below.
    let extension = unsafe {
        session
            .bind_extension(binding.as_raw(), roles, roles)
            .unwrap()
    };

    extension.set_rendering(true).unwrap();
    assert!(matches!(
        extension.assign_playback_region(&session, RendererRole::Playback, region),
        Err(AraError::InvalidState(_))
    ));
    extension.set_rendering(false).unwrap();

    let playback = extension
        .assign_playback_region(&session, RendererRole::Playback, region)
        .unwrap();
    let editor = extension
        .assign_playback_region(&session, RendererRole::Editor, region)
        .unwrap();
    let sequence_assignment = extension
        .assign_region_sequence(&session, sequence)
        .unwrap();
    extension
        .notify_selection(
            &session,
            &[region],
            &[sequence],
            Some(ContentTimeRange::new(1.0, 2.0).unwrap()),
        )
        .unwrap();
    extension
        .notify_hidden_region_sequences(&session, &[sequence])
        .unwrap();

    let selection = binding.view_selection().unwrap();
    assert_eq!(selection.playback_regions().len(), 1);
    assert_eq!(selection.region_sequences().len(), 1);
    assert_eq!(binding.hidden_region_sequences().len(), 1);
    assert_eq!(binding.assignment_counts(), (2, 1));

    session.close().unwrap();
    assert_eq!(binding.assignment_counts(), (0, 0));

    drop(sequence_assignment);
    drop(editor);
    drop(playback);
    drop(extension);
    drop(binding);
    controller_lease.destroy();
}

#[test]
#[cfg(not(target_arch = "aarch64"))]
fn ara1_legacy_extension_maps_set_and_remove_playback_region() {
    let trace = TestPluginTrace::new();
    let factory = build_test_factory(trace).unwrap();
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
    let region = {
        let mut edit = session.edit().unwrap();
        let context = edit
            .create_musical_context(MusicalContextProperties::new(None, 0, None).unwrap())
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
        edit.finish().unwrap();
        region
    };
    let (binding, lease) = build_test_extension(ApiGeneration::V1Final, 0, 0).unwrap();
    // SAFETY: fixture binding and lease retain the complete legacy prefix.
    let extension = unsafe {
        session
            .bind_extension(
                binding.as_raw(),
                ExtensionRoles::empty(),
                ExtensionRoles::empty(),
            )
            .unwrap()
    };

    let assignment = extension
        .assign_playback_region(&session, RendererRole::Playback, region)
        .unwrap();
    assert_eq!(binding.assignment_counts(), (2, 0));
    drop(assignment);
    assert_eq!(binding.assignment_counts(), (0, 0));

    drop(extension);
    session.close().unwrap();
    drop(binding);
    lease.destroy();
}
