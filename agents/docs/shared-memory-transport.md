# Cross-Process Shared-Memory Transport

This document records the persistent shared-page failure found on macOS, the
temporary containment, and the normative design for replacing
`ipc-channel::IpcSharedMemory` as YADAW's long-lived shared-memory primitive.
It is an architecture and delivery specification, not a user-facing support
note.

## Status

As of 2026-08-02, persistent pages created by `yadaw-ipc-transport` are not
cross-process coherent on macOS. Audio rendering continues, but the addon and
helper can observe different copies of telemetry and parameter state.

The current containment deliberately preserves correctness at reduced control
plane efficiency on macOS:

- transport and mixer snapshots use ordinary control requests;
- graph-publication waits use the compiled-graph control snapshot;
- every parameter command uses the existing priority lane;
- Windows and Linux continue using the persistent telemetry page and parameter
  ring;
- the temporary bulk arena keeps re-offering a region for every referencing
  packet on all platforms because macOS needs each message to receive a current
  immutable snapshot.

This containment is a safety net, not the target architecture. Do not remove it
until the replacement mapping passes the exit criteria below. Do not add more
`target_os = "macos"` policy above the transport boundary.

## Incident and root cause

The public `IpcSharedMemory` type presents one API on all platforms, but its
backends transfer different kernel capabilities:

| Platform                         | Creation and transfer path                                                                        | Persistent coherence                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Linux and supported Unix targets | file-backed region, `mmap(MAP_SHARED)`, backing FD sent with `SCM_RIGHTS`                         | both processes map the same backing object                           |
| Windows                          | page-file section from `CreateFileMapping`, section handle duplicated into the receiver           | both processes map the same section object                           |
| macOS                            | anonymous `vm_allocate` region sent as a Mach out-of-line descriptor with `MACH_MSG_VIRTUAL_COPY` | receiver gets a logical copy, normally backed by copy-on-write pages |

The macOS send path is visible in the
[`ipc-channel` 0.22.0 source](https://github.com/servo/ipc-channel/blob/v0.22.0/src/platform/macos/mod.rs#L507-L515).
Mach messages logically copy out-of-line memory into the receiving task;
virtual copy is a copy-on-write optimization rather than a durable shared
backing-object identity. See Apple's
[Mach overview](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/KernelProgramming/Mach/Mach.html).

The failure occurs after bootstrap:

```text
addon creates page P
  |-- addon retains a local clone for TelemetryReader / ParameterProducer
  `-- bootstrap serializes another clone
        `-- macOS helper receives COW page Q

initially: P and Q contain equal bytes
helper telemetry write: Q diverges; addon still reads P
addon parameter write:  P diverges; helper still reads Q
```

This explains the observed combination of symptoms: CoreAudio continues to
render audible samples, while the playhead and meters appear frozen and
parameter changes no longer reach the helper. CoreAudio is not the cause; it
only exposed a transport-semantic mismatch.

[`IpcSharedMemory`](https://docs.rs/ipc-channel/0.22.0/ipc_channel/ipc/struct.IpcSharedMemory.html)
documents a region made accessible to a message receiver, and its mutable
access contract recommends a single reader/writer, no cloning, and one
serialization/deserialization. It does not explicitly promise that a
sender-retained clone and a receiver mapping remain mutually visible. YADAW's
persistent pages require that stronger contract. Linux and Windows happened to
satisfy it; the macOS backend does not.

Same-process clone tests cannot catch this failure. The macOS local `Clone`
uses a shared `vm_remap`; divergence is introduced only by the later Mach
message transfer. Every persistent-mapping test must therefore spawn a real
second process.

## Required semantics

YADAW defines `process-shared mapping` to mean all of the following:

1. Every successful opener maps the same kernel backing object, not a snapshot
   of its bytes.
2. Naturally aligned supported atomic loads and stores are mutually visible
   between the owning processes according to the page protocol's ordering.
3. Mapping identity, length, generation, and layout are checked before typed
   access.
4. Closing one mapping does not invalidate another live mapping. The backing
   object becomes unreachable after all owners close it.
5. Creation, discovery, cleanup, peer failure, and startup timeout have
   deterministic outcomes.
6. Mapping and protocol failure are reported before activation and select an
   explicit control-plane fallback; partially verified pages never become
   active.
7. Creation, opening, mapping, and cleanup stay outside audio callbacks. Once
   active, the real-time path performs only the already bounded atomic or
   memory accesses defined by `yadaw-ipc-transport`.

"Reliable" means a narrow verified contract with fail-closed activation. It
does not mean mapping creation can never fail.

## Target architecture

Introduce an internal workspace crate with package name
`yadaw-shared-memory`. Keep it private until the API and three-platform test
matrix have stabilized.

```text
audio-host-client / audio-host
          |
          v
yadaw-ipc-transport
  - telemetry ABI and seqlock
  - parameter SPSC ABI
  - arena slots, leases, and publication
  - mapping handshake and generation swap
          |
          v
yadaw-shared-memory
  - create/open/map/unmap/unlink
  - opaque serializable descriptor
  - platform permissions and RAII
     |                    |
     |                    `-- Windows section mapping
     `-- POSIX shared object + MAP_SHARED

ipc-channel
  - control messages, descriptors, ready/abort, wakeups
  - never defines persistent-memory semantics
```

`yadaw-shared-memory` owns only the OS mapping capability and its lifecycle. It
must not become an allocator, synchronization library, typed-object store,
resizable heap, wakeup mechanism, or second general IPC framework.

`yadaw-ipc-transport` continues to own all byte layouts and concurrent
protocols. `ipc-channel` remains the control plane and carries the mapping
descriptor, readiness messages, wakeups, typed errors, and fallback traffic.

### Platform backends

The initial implementation uses discoverable, randomly named shared objects so
the existing serializable control protocol does not need arbitrary OS-handle
passing:

- macOS and Linux: `shm_open(O_CREAT | O_EXCL | O_RDWR, 0600)`, `ftruncate`,
  and `mmap(MAP_SHARED)`. The creator unlinks the name after peer verification;
  existing mappings remain alive.
- Windows: a randomly named page-file section created with
  `CreateFileMappingW`, opened with `OpenFileMappingW`, and mapped with
  `MapViewOfFile`. Its DACL is restricted to the current user/session. The
  object disappears after the final handle closes.

The public descriptor is platform-neutral and contains no pointer:

```rust
pub struct SharedRegionDescriptor {
    pub descriptor_version: u32,
    pub object_id: [u8; 16],
    pub byte_len: u64,
    pub generation: u64,
}
```

Backends derive their OS name from a cryptographically random object ID and a
YADAW-owned prefix. Opening code treats every descriptor as untrusted: reject
unsupported versions, zero or oversized lengths, malformed names, unexpected
generations, and any mapped length that differs from the descriptor.

Named objects are an initial delivery choice, not part of the public contract.
A later backend may transfer an inherited or duplicated handle without changing
the upper transport semantics.

### Ownership and unsafe boundary

Use separate owner and mapping types:

- `SharedRegionOwner` owns creation authority, the discoverable name until
  unlink, and best-effort cleanup in `Drop`. An explicit `unlink()` returns a
  typed error because `Drop` cannot report cleanup failure.
- `SharedRegionMapping` owns one mapped view and unmaps it in `Drop`.
- The mapping keeps the backing handle alive for at least as long as its view.
- No safe `DerefMut`, `&mut [u8]`, or arbitrary `&T` is exposed. Another
  process may mutate the bytes concurrently, so those Rust references would
  claim exclusivity or non-atomic stability that does not exist.
- Raw address access is `unsafe` and restricted to the transport crate. Its
  safety contract requires a live mapping, checked bounds, natural alignment,
  initialized atomic storage, one fixed field type per offset, and compatible
  access on every process.
- `Send` and `Sync` are implemented only if those invariants are documented and
  upheld by the owned handle and mapping lifecycle.

The supported initial ABI is 64-bit little-endian desktop targets with native
64-bit atomics. Do not emulate process-shared atomics with a process-local lock.

### Activation and lifecycle

Persistent mappings use an explicit state machine:

```text
Allocated
  -> Initialized
  -> Offered(descriptor, generation)
  -> PeerMapped
  -> BidirectionallyVerified
  -> Active
  -> Retiring
  -> Closed

any pre-Active failure -> Aborted -> control-plane fallback
```

Bootstrap performs a bidirectional challenge through atomic probe fields:

1. creator initializes header, layout, epoch, generation, and challenge A;
2. peer opens and validates the mapping, reads A, writes challenge B, and sends
   `Mapped` over the control channel;
3. creator observes B in the mapping and sends `Activate`;
4. peer acknowledges the active generation;
5. the POSIX creator unlinks the discoverable name.

This is capability detection, not a `target_os` assumption. A semantic
regression on any platform fails before the page is used and retains the
control fallback.

Resize never mutates a live backing object's length. The owner creates and
verifies generation N+1, publishes the generation switch at the relevant
control or audio block boundary, and retires N only after both sides have
acknowledged that they no longer access it.

## Refactor plan

### Phase 0 — Record and contain

- [x] Record the macOS COW root cause and distinguish transport buffers from
      persistent shared mappings.
- [x] Keep macOS telemetry, mixer, graph-publication, and parameter operations
      on existing control/priority paths.
- [x] Add smoke and unit coverage for the temporary platform behavior.
- [ ] Submit a minimal two-process mutation-visibility reproducer upstream to
      `servo/ipc-channel`; do not block the internal correction on its outcome.

Exit condition: macOS playback remains functionally correct without relying on
the stale persistent mappings.

### Phase 1 — Build the mapping crate in isolation

- [ ] Add `crates/shared-memory` and workspace dependency wiring.
- [ ] Implement the POSIX and Windows backends behind private modules.
- [ ] Define typed creation, open, length, unlink, mapping, and cleanup errors.
- [ ] Centralize all raw-pointer and OS-FFI operations with complete `SAFETY`
      documentation.
- [ ] Add a small child executable used only by real cross-process tests.

Exit condition: parent-to-child and child-to-parent atomic visibility passes on
macOS, Windows, and Linux CI, including peer exit and cleanup cases.

### Phase 2 — Add a negotiated persistent-page bootstrap

- [ ] Replace `HostBootstrap`'s persistent `IpcSharedMemory` values with
      versioned shared-region descriptors while leaving bulk arenas unchanged.
- [ ] Add `Mapped`, `Activate`, `Abort`, and generation acknowledgements to the
      priority/control protocol.
- [ ] Run the bidirectional visibility challenge for every helper session.
- [ ] Expose activation mode and failure counters in transport diagnostics.
- [ ] Keep fallback selection capability-based and observable.

Exit condition: the addon and helper cannot enter Ready with an unverified
persistent page, and injected verification failure selects the fallback.

### Phase 3 — Migrate telemetry and parameter pages

- [ ] Generalize `AtomicPage` over the new owned mapping rather than
      `IpcSharedMemory`.
- [ ] Migrate telemetry creation, reader/writer ownership, page growth, and
      retirement to generation-based mappings.
- [ ] Migrate the parameter producer/consumer ring and its wake protocol.
- [ ] Remove unconditional macOS routing from product policy while preserving
      the negotiated fallback.
- [ ] Verify playhead, graph revision, meters, mixer previews, plug-in
      parameters, gesture boundaries, and helper restart on all platforms.

Exit condition: the normal macOS path uses the same telemetry and parameter
protocols as Windows and Linux, with no high-frequency control-message
substitution.

### Phase 4 — Migrate persistent bulk arenas

- [ ] Create each arena region through `yadaw-shared-memory` and offer its
      descriptor once per generation.
- [ ] Remove the macOS per-packet re-offer workaround.
- [ ] Preserve lease publication, bounds, timeout quarantine, and release
      semantics unchanged above the mapping layer.
- [ ] Re-run large MIDI, plug-in state, waveform, and bidirectional attachment
      benchmarks.

Exit condition: no YADAW persistent data path depends on
`ipc-channel::IpcSharedMemory`; `ipc-channel` carries control messages only.

### Phase 5 — Harden and retire containment

- [ ] Run the full repository check and packaged helper smoke on all three
      desktop platforms.
- [ ] Compare release latency, parameter throughput, telemetry polling cost,
      mapped capacity, and helper startup against the pre-refactor Windows and
      Linux baselines and the contained macOS build.
- [ ] Remove obsolete platform flags and counters only after two-way visibility
      and product smokes are required CI gates.
- [ ] Update `ipc-v2-delivery.md` with the delivered commit sequence and measured
      results.

Exit condition: the capability-verified shared path is the default everywhere;
fallback remains tested but is inactive in ordinary supported environments.

## Required test matrix

Unit tests and same-process mapping tests are necessary but insufficient. CI
must run real parent/child processes on macOS, Windows, and Linux for:

- parent write observed by child and child write observed by parent;
- repeated atomic publication with no stale terminal value or torn snapshot;
- telemetry seqlock under sustained writer/reader contention;
- parameter ring empty/wake, wrap, soft-full reserve, hard-full fallback, and
  stale epoch behavior;
- peer crash before open, after open, after verification, and while active;
- startup timeout, malformed descriptor, wrong length/version/generation, and
  duplicate activation;
- generation replacement while readers still hold the old mapping;
- POSIX unlink after verification and Windows final-handle cleanup;
- arena lease publication, out-of-order release, quarantine, and reuse;
- packaged-helper playback using the mock backend: advancing playhead, moving
  meters, applied mixer/plugin parameter, and clean restart.

Loom remains useful for modeling the in-memory publication protocols, but it
does not replace OS-process tests. A test that only clones a mapping in one
process does not cover capability transfer.

## Review and acceptance gates

The refactor is complete only when all of these statements are true:

- one normative persistent-mapping contract is documented and tested on every
  supported desktop OS;
- platform-specific code is confined to `yadaw-shared-memory` private backends;
- upper transport and product code contain no macOS-specific semantic branch;
- every active mapping completed two-way verification for its session and
  generation;
- unsafe typed access has a local, reviewable invariant and never exposes a
  safe mutable slice across processes;
- startup, resize, restart, peer crash, and cleanup have typed terminal states;
- no mapping lifecycle work, IPC, allocation, lock, or cleanup enters an audio
  callback;
- the persistent page and arena hot paths meet or improve the existing Windows
  and Linux release baselines;
- the control fallback remains bounded, observable, and covered by failure
  injection.

## Explicit non-goals

- Do not fork `ipc-channel` or silently redefine its public
  `IpcSharedMemory` semantics for all consumers.
- Do not expose shared memory to Electron renderer, preload, Pinia, project
  workers, or the project database.
- Do not store Rust-owned pointers, `Vec`, `String`, trait objects, or
  process-local handles in a shared layout.
- Do not add process-shared locks, a general allocator, in-place resize, or
  crash-recovery persistence to the first crate version.
- Do not remove the control fallback merely because platform-name detection
  says a mapping should work; activation is based on observed capability.
