use ara2_bridge_core::ApiGeneration;
use ara2_bridge_host::LoadedFactory;
use ara2_bridge_sys::{
    ARAAssertCategory, ARAFactory, ARAPersistentID, ARASize, access::write_field,
    kARAFactoryMinSize,
};
use ara2_bridge_testkit::{TestPluginTrace, build_test_factory};
use std::ffi::{c_char, c_void};
use std::mem::offset_of;

unsafe extern "C" fn assertion(_: ARAAssertCategory, _: *const c_void, _: *const c_char) {}

#[test]
fn factory_loading_copies_metadata_and_balances_initialization() {
    let factory = build_test_factory(TestPluginTrace::new()).unwrap();
    assert_eq!(factory.entry().generation(), None);
    {
        // SAFETY: the Rust fixture owns stable factory backing beyond the loaded guard.
        let loaded = unsafe {
            LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion))
        }
        .unwrap();
        assert_eq!(loaded.generation(), ApiGeneration::V23Final);
        assert_eq!(loaded.metadata().factory_id(), "org.ara2-bridge.test");
        assert_eq!(loaded.metadata().plug_in_name(), "ARA2 Bridge Test Plug-In");
        assert_eq!(loaded.metadata().manufacturer_name(), "ara2-bridge");
        assert_eq!(loaded.metadata().version(), "0.3.0");
        assert_eq!(
            loaded.metadata().document_archive_id(),
            "org.ara2-bridge.test.archive"
        );
        assert_eq!(loaded.metadata().analyzable_content_types().len(), 6);
        assert!(loaded.metadata().stores_audio_file_chunks());
        assert_eq!(factory.entry().generation(), Some(ApiGeneration::V23Final));
    }
    assert_eq!(factory.entry().generation(), None);
}

#[test]
fn factory_loading_rejects_null_and_unsupported_generations_without_initializing() {
    // SAFETY: null is explicitly accepted for validation and rejected before dereference.
    assert!(
        unsafe {
            LoadedFactory::load(
                std::ptr::null::<ARAFactory>(),
                ApiGeneration::V23Final,
                Some(assertion),
            )
        }
        .is_err()
    );
    let factory = build_test_factory(TestPluginTrace::new()).unwrap();
    // SAFETY: stable fixture factory; V1Draft is outside its advertised range.
    assert!(
        unsafe { LoadedFactory::load(factory.as_raw(), ApiGeneration::V1Draft, Some(assertion)) }
            .is_err()
    );
    assert_eq!(factory.entry().generation(), None);
}

#[test]
fn malformed_factory_prefixes_and_metadata_are_rejected_before_initialization() {
    let factory = build_test_factory(TestPluginTrace::new()).unwrap();

    let mut truncated = factory.raw_copy();
    // SAFETY: the local packed record is uniquely owned and this writes its header field.
    unsafe {
        write_field(
            (&raw mut truncated).cast(),
            offset_of!(ARAFactory, structSize),
            kARAFactoryMinSize as ARASize - 1,
        )
    };
    // SAFETY: all advertised backing belongs to `factory`; validation rejects the short prefix.
    assert!(
        unsafe {
            LoadedFactory::load(
                &raw const truncated,
                ApiGeneration::V23Final,
                Some(assertion),
            )
        }
        .is_err()
    );

    let mut missing_create = factory.raw_copy();
    // SAFETY: the local packed record is uniquely owned and callback absence is intentional.
    unsafe {
        write_field::<
            Option<
                unsafe extern "C" fn(
                    *const ara2_bridge_sys::ARADocumentControllerHostInstance,
                    *const ara2_bridge_sys::ARADocumentProperties,
                )
                    -> *const ara2_bridge_sys::ARADocumentControllerInstance,
            >,
        >(
            (&raw mut missing_create).cast(),
            offset_of!(ARAFactory, createDocumentControllerWithDocument),
            None,
        )
    };
    // SAFETY: stable fixture backing; callback validation happens before initialization.
    assert!(
        unsafe {
            LoadedFactory::load(
                &raw const missing_create,
                ApiGeneration::V23Final,
                Some(assertion),
            )
        }
        .is_err()
    );

    let mut bad_pair = factory.raw_copy();
    // SAFETY: both fields belong to the unique local record; the inconsistent pair is deliberate.
    unsafe {
        write_field(
            (&raw mut bad_pair).cast(),
            offset_of!(ARAFactory, compatibleDocumentArchiveIDsCount),
            1_usize,
        );
        write_field::<*const ARAPersistentID>(
            (&raw mut bad_pair).cast(),
            offset_of!(ARAFactory, compatibleDocumentArchiveIDs),
            std::ptr::null(),
        );
    }
    // SAFETY: stable fixture backing; metadata validation rejects the bad pair before init.
    assert!(
        unsafe {
            LoadedFactory::load(
                &raw const bad_pair,
                ApiGeneration::V23Final,
                Some(assertion),
            )
        }
        .is_err()
    );
    assert_eq!(factory.entry().generation(), None);
}

#[test]
fn concurrent_factories_share_one_stable_assertion_address_per_generation() {
    let first_factory = build_test_factory(TestPluginTrace::new()).unwrap();
    // SAFETY: the first fixture outlives its loaded guard.
    let first = unsafe {
        LoadedFactory::load(
            first_factory.as_raw(),
            ApiGeneration::V23Final,
            Some(assertion),
        )
    }
    .unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let factory = build_test_factory(TestPluginTrace::new()).unwrap();
            // SAFETY: the thread-local fixture outlives its loaded guard.
            let loaded = unsafe {
                LoadedFactory::load(factory.as_raw(), ApiGeneration::V23Final, Some(assertion))
            }
            .unwrap();
            assert_eq!(loaded.generation(), ApiGeneration::V23Final);
        });
    });
    assert_eq!(first.generation(), ApiGeneration::V23Final);
}
