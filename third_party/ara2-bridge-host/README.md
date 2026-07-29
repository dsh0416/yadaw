# ara2-bridge-host

Safe ARA 2.3 host-authoring runtime for Rust. The crate loads foreign factories, constructs stable host-service vtables, owns a checked document graph, dispatches all document-controller operations, binds companion extension roles, and performs deterministic teardown.

## Host services

Build one `HostServices` value per document with implementations of the required `AudioAccessProvider` and `ArchivingProvider` traits. Add `ContentAccessProvider`, `ModelUpdateProvider`, and `PlaybackProvider` when the host exposes those services:

```rust,ignore
let services = HostServicesBuilder::new()
    .audio(MyAudioProvider::new())
    .archiving(MyArchiveProvider::new())
    .model_updates(MyUpdateSink::new())
    .build(ApiGeneration::V23Final)?;
```

Providers are panic-contained and document-local. Audio readers are synchronously revoked on source disable, destruction, or document close.

## Factory and document lifecycle

Load a stable raw `ARAFactory` with `LoadedFactory::load`, then create a `DocumentSession`. Use `session.edit()` for graph mutation. Handles are document-scoped; the runtime rejects stale, foreign, wrong-order, and invalid-edge operations before FFI. ARA1 playback graphs are normalized internally while ARA2 exposes contexts, sequences, sources, modifications, and regions directly.

Call `DocumentSession::close` to remove extension assignments and readers, destroy graph objects leaf-first, and release the controller. It attempts every safe teardown step and returns all failures together.

## Content, persistence, and extensions

Document sessions provide typed content readers for sources, modifications, and regions; analysis requests and update flushing; full and filtered archive operations; processing-algorithm selection; licensing; signal-preservation and head/tail queries; and source-to-audio-file chunk storage. Reader lifetimes retain exclusive controller access.

Use unsafe `bind_extension` only after a companion adapter has bound the exact instance to the document. The returned controller validates role/interface pairs and supplies RAII playback-region and region-sequence assignments plus copied editor-view notifications.

## Verification

```bash
cargo test -p ara2-bridge-host
cargo test -p ara2-bridge-testkit --test rust_interop
MIRIFLAGS=-Zmiri-strict-provenance cargo +nightly miri test -p ara2-bridge-testkit --test rust_interop
```

`ara2_bridge_testkit::scenarios::basic_document_smoke` is the public-API host ↔ plug-in smoke path.
