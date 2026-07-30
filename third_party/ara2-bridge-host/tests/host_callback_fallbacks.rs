use ara2_bridge_core::{ApiGeneration, AraError, ContentGrade, ContentTimeRange};
use ara2_bridge_host::*;
use ara2_bridge_sys::*;
use std::collections::BTreeSet;
use std::ffi::c_void;
use std::mem::offset_of;
use std::ptr::{null, null_mut};

struct Audio;
impl AudioAccessProvider for Audio {
    fn create_reader(
        &self,
        _: AudioSourceId,
        _: bool,
    ) -> Result<Box<dyn HostAudioReader>, AraError> {
        Err(AraError::Peer("unused"))
    }
}

struct Archive;
impl ArchivingProvider for Archive {
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

struct Content;
impl ContentAccessProvider for Content {
    fn musical_context_grade(
        &self,
        _: MusicalContextId,
        _: i32,
    ) -> Result<Option<ContentGrade>, AraError> {
        Ok(None)
    }
    fn musical_context_reader(
        &self,
        _: MusicalContextId,
        _: i32,
        _: Option<ContentTimeRange>,
    ) -> Result<Option<HostContentReaderSnapshot>, AraError> {
        Ok(None)
    }
    fn audio_source_grade(
        &self,
        _: AudioSourceId,
        _: i32,
    ) -> Result<Option<ContentGrade>, AraError> {
        Ok(None)
    }
    fn audio_source_reader(
        &self,
        _: AudioSourceId,
        _: i32,
        _: Option<ContentTimeRange>,
    ) -> Result<Option<HostContentReaderSnapshot>, AraError> {
        Ok(None)
    }
}

struct Updates;
impl ModelUpdateProvider for Updates {}

struct Playback;
impl PlaybackProvider for Playback {
    fn start(&self) -> Result<(), AraError> {
        Ok(())
    }
    fn stop(&self) -> Result<(), AraError> {
        Ok(())
    }
    fn set_position(&self, _: f64) -> Result<(), AraError> {
        Ok(())
    }
    fn set_cycle_range(&self, _: f64, _: f64) -> Result<(), AraError> {
        Ok(())
    }
    fn enable_cycle(&self, _: bool) -> Result<(), AraError> {
        Ok(())
    }
}

#[test]
fn every_host_callback_has_a_null_host_fallback() {
    let services = HostServicesBuilder::new()
        .audio(Audio)
        .archiving(Archive)
        .content(Content)
        .model_updates(Updates)
        .playback(Playback)
        .build(ApiGeneration::V23Final)
        .unwrap();
    let instance = services.instance();
    let mut driven = BTreeSet::new();
    macro_rules! call {
        ($set:expr, $name:literal, $interface:expr, $record:ty, $field:ident, $signature:ty $(, $arg:expr)*) => {{
            let callback = callback::<$signature>(($interface).cast(), offset_of!($record, $field));
            assert!($set.insert($name));
            // SAFETY: a null host reference selects the callback fallback before arguments are read.
            unsafe { callback(null_mut() $(, $arg)*) }
        }};
    }

    let audio = instance.audioAccessControllerInterface;
    assert!(
        call!(
            driven,
            "createAudioReaderForSource",
            audio,
            ARAAudioAccessControllerInterface,
            createAudioReaderForSource,
            unsafe extern "C" fn(
                ARAAudioAccessControllerHostRef,
                ARAAudioSourceHostRef,
                ARABool,
            ) -> ARAAudioReaderHostRef,
            null_mut(),
            kARAFalse
        )
        .is_null()
    );
    assert_eq!(
        call!(
            driven,
            "readAudioSamples",
            audio,
            ARAAudioAccessControllerInterface,
            readAudioSamples,
            unsafe extern "C" fn(
                ARAAudioAccessControllerHostRef,
                ARAAudioReaderHostRef,
                ARASamplePosition,
                ARASampleCount,
                *const *mut c_void,
            ) -> ARABool,
            null_mut(),
            0,
            0,
            null()
        ),
        kARAFalse
    );
    call!(
        driven,
        "destroyAudioReader",
        audio,
        ARAAudioAccessControllerInterface,
        destroyAudioReader,
        unsafe extern "C" fn(ARAAudioAccessControllerHostRef, ARAAudioReaderHostRef),
        null_mut()
    );

    let archive = instance.archivingControllerInterface;
    assert_eq!(
        call!(
            driven,
            "getArchiveSize",
            archive,
            ARAArchivingControllerInterface,
            getArchiveSize,
            unsafe extern "C" fn(ARAArchivingControllerHostRef, ARAArchiveReaderHostRef) -> ARASize,
            null_mut()
        ),
        0
    );
    assert_eq!(
        call!(
            driven,
            "readBytesFromArchive",
            archive,
            ARAArchivingControllerInterface,
            readBytesFromArchive,
            unsafe extern "C" fn(
                ARAArchivingControllerHostRef,
                ARAArchiveReaderHostRef,
                ARASize,
                ARASize,
                *mut ARAByte,
            ) -> ARABool,
            null_mut(),
            0,
            0,
            null_mut()
        ),
        kARAFalse
    );
    assert_eq!(
        call!(
            driven,
            "writeBytesToArchive",
            archive,
            ARAArchivingControllerInterface,
            writeBytesToArchive,
            unsafe extern "C" fn(
                ARAArchivingControllerHostRef,
                ARAArchiveWriterHostRef,
                ARASize,
                ARASize,
                *const ARAByte,
            ) -> ARABool,
            null_mut(),
            0,
            0,
            null()
        ),
        kARAFalse
    );
    call!(
        driven,
        "notifyDocumentArchivingProgress",
        archive,
        ARAArchivingControllerInterface,
        notifyDocumentArchivingProgress,
        unsafe extern "C" fn(ARAArchivingControllerHostRef, f32),
        0.0
    );
    call!(
        driven,
        "notifyDocumentUnarchivingProgress",
        archive,
        ARAArchivingControllerInterface,
        notifyDocumentUnarchivingProgress,
        unsafe extern "C" fn(ARAArchivingControllerHostRef, f32),
        0.0
    );
    assert!(
        call!(
            driven,
            "getDocumentArchiveID",
            archive,
            ARAArchivingControllerInterface,
            getDocumentArchiveID,
            unsafe extern "C" fn(
                ARAArchivingControllerHostRef,
                ARAArchiveReaderHostRef,
            ) -> ARAPersistentID,
            null_mut()
        )
        .is_null()
    );

    let content = instance.contentAccessControllerInterface;
    assert_eq!(
        call!(
            driven,
            "isMusicalContextContentAvailable",
            content,
            ARAContentAccessControllerInterface,
            isMusicalContextContentAvailable,
            unsafe extern "C" fn(
                ARAContentAccessControllerHostRef,
                ARAMusicalContextHostRef,
                ARAContentType,
            ) -> ARABool,
            null_mut(),
            0
        ),
        kARAFalse
    );
    assert_eq!(
        call!(
            driven,
            "getMusicalContextContentGrade",
            content,
            ARAContentAccessControllerInterface,
            getMusicalContextContentGrade,
            unsafe extern "C" fn(
                ARAContentAccessControllerHostRef,
                ARAMusicalContextHostRef,
                ARAContentType,
            ) -> ARAContentGrade,
            null_mut(),
            0
        ),
        kARAContentGradeInitial as ARAContentGrade
    );
    assert!(
        call!(
            driven,
            "createMusicalContextContentReader",
            content,
            ARAContentAccessControllerInterface,
            createMusicalContextContentReader,
            unsafe extern "C" fn(
                ARAContentAccessControllerHostRef,
                ARAMusicalContextHostRef,
                ARAContentType,
                *const ARAContentTimeRange,
            ) -> ARAContentReaderHostRef,
            null_mut(),
            0,
            null()
        )
        .is_null()
    );
    assert_eq!(
        call!(
            driven,
            "isAudioSourceContentAvailable",
            content,
            ARAContentAccessControllerInterface,
            isAudioSourceContentAvailable,
            unsafe extern "C" fn(
                ARAContentAccessControllerHostRef,
                ARAAudioSourceHostRef,
                ARAContentType,
            ) -> ARABool,
            null_mut(),
            0
        ),
        kARAFalse
    );
    assert_eq!(
        call!(
            driven,
            "getAudioSourceContentGrade",
            content,
            ARAContentAccessControllerInterface,
            getAudioSourceContentGrade,
            unsafe extern "C" fn(
                ARAContentAccessControllerHostRef,
                ARAAudioSourceHostRef,
                ARAContentType,
            ) -> ARAContentGrade,
            null_mut(),
            0
        ),
        kARAContentGradeInitial as ARAContentGrade
    );
    assert!(
        call!(
            driven,
            "createAudioSourceContentReader",
            content,
            ARAContentAccessControllerInterface,
            createAudioSourceContentReader,
            unsafe extern "C" fn(
                ARAContentAccessControllerHostRef,
                ARAAudioSourceHostRef,
                ARAContentType,
                *const ARAContentTimeRange,
            ) -> ARAContentReaderHostRef,
            null_mut(),
            0,
            null()
        )
        .is_null()
    );
    assert_eq!(
        call!(
            driven,
            "getContentReaderEventCount",
            content,
            ARAContentAccessControllerInterface,
            getContentReaderEventCount,
            unsafe extern "C" fn(
                ARAContentAccessControllerHostRef,
                ARAContentReaderHostRef,
            ) -> ARAInt32,
            null_mut()
        ),
        0
    );
    assert!(
        call!(
            driven,
            "getContentReaderDataForEvent",
            content,
            ARAContentAccessControllerInterface,
            getContentReaderDataForEvent,
            unsafe extern "C" fn(
                ARAContentAccessControllerHostRef,
                ARAContentReaderHostRef,
                ARAInt32,
            ) -> *const c_void,
            null_mut(),
            0
        )
        .is_null()
    );
    call!(
        driven,
        "destroyContentReader",
        content,
        ARAContentAccessControllerInterface,
        destroyContentReader,
        unsafe extern "C" fn(ARAContentAccessControllerHostRef, ARAContentReaderHostRef),
        null_mut()
    );

    let updates = instance.modelUpdateControllerInterface;
    call!(
        driven,
        "notifyAudioSourceAnalysisProgress",
        updates,
        ARAModelUpdateControllerInterface,
        notifyAudioSourceAnalysisProgress,
        unsafe extern "C" fn(
            ARAModelUpdateControllerHostRef,
            ARAAudioSourceHostRef,
            ARAAnalysisProgressState,
            f32,
        ),
        null_mut(),
        0,
        0.0
    );
    call!(
        driven,
        "notifyAudioSourceContentChanged",
        updates,
        ARAModelUpdateControllerInterface,
        notifyAudioSourceContentChanged,
        unsafe extern "C" fn(
            ARAModelUpdateControllerHostRef,
            ARAAudioSourceHostRef,
            *const ARAContentTimeRange,
            ARAContentUpdateFlags,
        ),
        null_mut(),
        null(),
        0
    );
    call!(
        driven,
        "notifyAudioModificationContentChanged",
        updates,
        ARAModelUpdateControllerInterface,
        notifyAudioModificationContentChanged,
        unsafe extern "C" fn(
            ARAModelUpdateControllerHostRef,
            ARAAudioModificationHostRef,
            *const ARAContentTimeRange,
            ARAContentUpdateFlags,
        ),
        null_mut(),
        null(),
        0
    );
    call!(
        driven,
        "notifyPlaybackRegionContentChanged",
        updates,
        ARAModelUpdateControllerInterface,
        notifyPlaybackRegionContentChanged,
        unsafe extern "C" fn(
            ARAModelUpdateControllerHostRef,
            ARAPlaybackRegionHostRef,
            *const ARAContentTimeRange,
            ARAContentUpdateFlags,
        ),
        null_mut(),
        null(),
        0
    );
    call!(
        driven,
        "notifyDocumentDataChanged",
        updates,
        ARAModelUpdateControllerInterface,
        notifyDocumentDataChanged,
        unsafe extern "C" fn(ARAModelUpdateControllerHostRef)
    );

    let playback = instance.playbackControllerInterface;
    call!(
        driven,
        "requestStartPlayback",
        playback,
        ARAPlaybackControllerInterface,
        requestStartPlayback,
        unsafe extern "C" fn(ARAPlaybackControllerHostRef)
    );
    call!(
        driven,
        "requestStopPlayback",
        playback,
        ARAPlaybackControllerInterface,
        requestStopPlayback,
        unsafe extern "C" fn(ARAPlaybackControllerHostRef)
    );
    call!(
        driven,
        "requestSetPlaybackPosition",
        playback,
        ARAPlaybackControllerInterface,
        requestSetPlaybackPosition,
        unsafe extern "C" fn(ARAPlaybackControllerHostRef, ARATimePosition),
        0.0
    );
    call!(
        driven,
        "requestSetCycleRange",
        playback,
        ARAPlaybackControllerInterface,
        requestSetCycleRange,
        unsafe extern "C" fn(ARAPlaybackControllerHostRef, ARATimePosition, ARATimeDuration),
        0.0,
        0.0
    );
    call!(
        driven,
        "requestEnableCycle",
        playback,
        ARAPlaybackControllerInterface,
        requestEnableCycle,
        unsafe extern "C" fn(ARAPlaybackControllerHostRef, ARABool),
        kARAFalse
    );

    assert_eq!(driven, host_callback_manifest().iter().copied().collect());
}

fn callback<T: Copy>(interface: *const c_void, offset: usize) -> T {
    // SAFETY: each offset names a represented callback in the live packed interface.
    unsafe { ara2_bridge_sys::access::read_field::<Option<T>>(interface.cast(), offset) }.unwrap()
}
