# Playback Runtime Architecture

This document is the agent-facing specification for YADAW's playback graph,
threads, asynchronous control plane, background workers, and VST3 runtime. It
defines ownership and real-time invariants for the VST3/Tokio migration.

The helper control plane uses lockstep application messages over `ipc-channel`,
a configurable Tokio multi-thread runtime, bounded actor mailboxes, persistent
mapping interfaces, and a winit process main thread. Windows and Linux use the
shared-page implementation; macOS currently selects the documented bounded
fallback until capability-verified mappings replace it.
Streaming clips are cooperatively serviced by a fixed pool of two to four
background lanes; there is no production prefetch thread per clip. Graph
construction and PDC calculation run on the supervised graph worker owned by
`BackgroundIoActor` (general `yadaw-background-io-*` lanes with generation
cancellation). Clip prefetch and the recording writer still use their dedicated
pools until a later migration folds them into the same supervisor priorities.
The old length-prefixed MessagePack transport remains only as a compatibility
entry point for standalone tools. Update this document in the same change
whenever an ownership boundary or concurrency rule changes.

## System shape

```text
Vue / Pinia
  -> window.yadaw
  -> Electron main services
  -> audio-host-client (.node)
       ├─ request_id -> JsDeferred response router (up to 256 in flight)
       ├─ independent normal, priority-heartbeat, and event channels
       ├─ telemetry reader and parameter producer (shared page or fallback)
       ├─ helper lifecycle and lease ownership
       └─ servo/ipc-channel
            |
            v
       yadaw-audio-host process
       ├─ process main thread: winit + VST3 controller/editor/windows
       ├─ yadaw-control: LocalSet for VST3/thread-affine work
       ├─ yadaw-tokio workers: Engine, protocol tasks, I/O, telemetry
       ├─ dedicated priority/normal IPC ingress thread
       ├─ async outbound actor + bounded blocking sends
       ├─ cpal-owned real-time callback threads
       └─ supervised background workers
            ├─ one recording lane
            └─ bounded general workers for streaming and graph builds
```

`dsp-node` remains an Electron-main-only addon for offline audio utilities,
MIDI parsing, database audio helpers, and benchmarks. It does not own a live
device, transport, recording session, playback graph, or plugin instance.

## Ownership map

| Domain                                 | Sole owner                        | Other access                       |
| -------------------------------------- | --------------------------------- | ---------------------------------- |
| Helper request lifecycle               | `ProtocolActor`                   | typed handles and one-shot replies |
| Audio devices and cpal streams         | `EngineActor`                     | atomic runtime snapshots           |
| Device-boundary SRC state and buffers  | cpal callbacks                    | startup-allocated, callback-local  |
| Active playback graph                  | cpal output callback              | SPSC graph commands                |
| Graph construction and PDC calculation | supervised graph worker           | immutable build input              |
| Retired graphs                         | control side of `EngineActor`     | callback pushes to retirement SPSC |
| VST3 controller and editor             | winit main thread / `Vst3Actor`   | bounded mailbox                    |
| VST3 processor                         | active playback graph             | stable processor registry/lease    |
| Transport position while running       | audio callback                    | atomic snapshot                    |
| Streaming file readers                 | background worker registry        | atomic window controls             |
| Streaming sample windows               | source state shared with callback | double-buffered atomic publication |
| Recording file writer                  | dedicated recording lane          | recording SPSC consumer            |
| Plugin/project persistence             | Electron main                     | explicit state-save requests       |

An object must not have two mutable owners. A cloneable handle contains a
sender, immutable metadata, or atomics; it is not a second owner of the domain.

## Control runtime and actors

The helper has exactly one explicitly constructed Tokio multi-thread runtime.
The `yadaw-control` thread enters it through one long-lived `LocalSet` for VST3
and other thread-affine objects. `EngineActor`, background I/O, telemetry,
request tasks, response encoding, and egress scheduling use `tokio::spawn`.
winit is never used to periodically poll Tokio.

Resolved defaults are conservative: workers are
`clamp(ceil(logical cores / 4), 1, 4)`, the blocking ceiling is
`clamp(workers × 2, 2, 8)`, and egress concurrency is
`min(2, blocking ceiling)`. Advanced settings may request workers 1–8,
blocking threads 2–16, and egress concurrency 1–4 (never above the blocking
ceiling). Applying them is a controlled helper restart, not an Electron
restart.

Production helper code must not use:

- the implicit Tokio runtime defaults or an unbounded worker count;
- `spawn_blocking` outside the configured blocking budget;
- an unbounded Tokio channel;
- an ad hoc worker thread outside the runtime/bootstrap/worker modules;
- a mutex or read/write lock guard held across `.await`.

The control-plane actors are:

| Actor               | Mailbox capacity | Responsibilities                                       |
| ------------------- | ---------------: | ------------------------------------------------------ |
| `ProtocolActor`     |              256 | version validation, request IDs, deadlines, routing    |
| `EngineActor`       |               64 | devices, streams, transport, graph publication, meters |
| `Vst3Actor`         |               64 | LocalSet-only instances, state, editor, latency events |
| `BackgroundIoActor` |              128 | recording, streaming registry, graph and waveform jobs |
| `OutboundActor`     |              256 | async replies and strictly ordered runtime events      |

Request/response operations carry a Tokio one-shot sender. The caller owns the
deadline and cancellation token. A dropped receiver cancels work when the
operation is safe to cancel; irreversible cleanup such as recording finalization
continues and publishes its terminal event.

Default deadlines are:

- 2 seconds for heartbeat, transport, parameters, meters, and device control;
- 15 seconds for graph/plugin loading, plugin state, and editor operations;
- 15 seconds plus process termination for an isolated plugin probe.

When a mailbox is full, structural work returns `Busy`. Latest-value telemetry
and parameter previews may replace an older queued value. Shutdown, crash, and
fatal actor events use reserved capacity and must not be dropped.

No actor waits synchronously for another actor. It awaits a one-shot reply or
uses a versioned observation. Cycles between actor mailboxes are architecture
errors.

## IPC boundary

Cross-process messages use `servo/ipc-channel`. There is no message-level
protocol version and no compatibility branch: addon and helper are lockstep
application resources. Bootstrap transfers channels and currently carries
persistent pages as `IpcSharedMemory` attachments. The target bootstrap replaces
those attachments with persistent-page descriptors; neither form infers
compatibility from a version or source fingerprint. Packaging and the native
smoke test guarantee that the addon launches the helper from the same build.
Mapping capability is a separate runtime invariant: a target persistent page
must complete the two-way verification defined in
[Cross-process shared-memory transport](shared-memory-transport.md) before
activation.

The outer value is `WirePacket { body, region_offers }`: `body` is a bounded
MessagePack request/reply/event. The current `region_offers` re-offers every
mapping referenced by a packet because macOS needs a fresh snapshot; after the
mapping refactor it will contain only descriptors not already registered by the
receiver. Shared-page and MIDI layout versions remain independent safety
invariants for typed memory access; they are not message compatibility versions.

```text
WirePacket
  body: ControlRequest | ControlResponse | PriorityRequest | PriorityResponse | HostEvent
  region_offers: RegionOffer[]
```

Binary fields use `BinaryPayload::Inline` through 64 KiB, an addon-only
`Attachment` index at the Node boundary, and `BinaryPayload::Shared` on the
native wire. Shared references contain session epoch, stable region ID and
generation, allocation slot and generation, checked offset/length, and lease
ID. There is intentionally no checksum: both processes are trusted application
resources, while stale/session/bounds/publication checks prevent accidental
reuse.
Component/controller state, waveform peaks, raw MIDI/SysEx, and encoded large
MIDI batches use this path. The addon validates and copies a received temporary
blob exactly once into an ordinary Node Buffer; Electron never owns an external
Buffer backed by a cross-process mapping.

Large MIDI batches are not MessagePack documents inside the shared blob. They
use a versioned, little-endian fixed ABI with a 32-byte magic/version/count
header. Notes are a contiguous array of 24-byte POD records. Non-note events
use fixed 40-byte descriptors whose checked offsets reference UTF-8 event-kind
and payload bytes in a trailing data area. `yadaw-ipc-transport` validates the
header, element size, total length, reserved fields, UTF-8, and every offset
before exposing a `zerocopy` borrowed slice.

The graph compiler reads shared notes directly from that borrowed slice into
the final preallocated native graph buffer; it must not first deserialize a
temporary `Vec<LiveMidiNote>`. A separate owned protocol snapshot is
materialized once before the request lease is released because later
stable-ID patches need a baseline that outlives the request. The real-time
graph never retains a temporary bulk-arena lease. If persistent zero-copy
graph data is introduced later, it requires a separate immutable graph arena
with graph-retirement ownership, not the attachment arena.

Each direction owns a separate, lazily grown arena with 1, 4, 16, and 64 MiB
data-region classes. A region has at most 64 allocation slots and an aligned
extent allocator that supports out-of-order release and adjacent-extent
coalescing. Each direction is limited to 32 regions, 256 MiB mapped capacity,
256 in-flight leases, and a 64 MiB blob/packet. The producer writes an
unpublished extent, then publishes slot metadata with Release; the consumer
validates it with Acquire before reading. Every packet that references a region
currently re-offers that region's `IpcSharedMemory` handle, and receivers
replace their mapping for the region id. This is temporary containment for
macOS, where `ipc-channel` delivers a copy-on-write snapshot that goes stale
after the producer writes again. The shared-memory refactor will offer one
verified mapping per arena generation and remove the per-packet re-offer.

The sender retains an allocation until `ReleaseLeases`. Release happens after
the final command consumer completes, or after the addon copies a response
into its owned `Vec`/Node Buffer. A 30-second timeout quarantines the whole
region until session close; it is never reused, preventing a late-reader
use-after-free. Arena exhaustion returns typed `Busy`; there is no unbounded
wait queue. Telemetry pages and the parameter ring are logically separate
persistent mappings. Until the new mapping layer is delivered, the macOS
product path does not rely on those stale mappings and uses bounded
control/priority fallbacks instead.

Bootstrap transfers these independent paths:

```text
normal requests  -> normal replies
priority requests -> priority replies
events
telemetry page (persistent)
parameter SPSC ring (persistent)
session epoch
```

Electron main calls the addon with `{ body, attachments }`. The addon copies
each Node Buffer into the client→host arena synchronously on the calling
thread, so no background Rust task reads a Buffer JavaScript can still mutate.
On responses it makes one arena→`Vec` copy and transfers that allocation into
a Node Buffer. Large payload bytes are therefore never MessagePack-encoded at
the Node/Rust boundary.

The addon response router owns the blocking normal receiver and resolves
`request_id -> JsDeferred` in any order. Deadlines are scanned by the router;
helper exit rejects all pending promises at once. Event and priority response
routers have separate receivers. No request occupies libuv's worker pool while
waiting for IPC.

`ipc-channel` receive operations are blocking and its internal send queue is
not the application's backpressure mechanism. A dedicated ingress thread
wraps bounded actor mailboxes. Normal ingress uses `try_send` into the
256-entry Tokio protocol
mailbox and returns `Busy` when saturated. Priority ingress answers heartbeat
directly from liveness atomics; it never waits for Tokio, VST3, graph building,
or the normal mailbox. Shutdown, lease release, parameter wake, and gesture
boundary fallbacks use its reserved mailbox. Tokio actors enqueue replies to a
bounded async outbound mailbox. Responses may encode and send out of order up
to the configured egress concurrency; the independent event lane stays
strictly ordered. Arena copies, encoding, and synchronous
`ipc-channel::send` run as bounded blocking jobs and never occupy async
workers.

Heartbeat reports independent IPC-receive, Tokio-dispatch, winit-dispatch, and
audio-callback generations. This makes a control-runtime hang distinguishable
from a plugin editor hang or audio callback stall.

### Persistent real-time pages

The following is the normative steady-state design. The existing
`IpcSharedMemory` bootstrap meets it on Windows and Linux but not macOS. The
macOS containment reads transport/mixer/graph observations through control
requests and sends every parameter command on the priority lane. It must be
removed only after the new mappings pass cross-process two-way verification;
see [Cross-process shared-memory transport](shared-memory-transport.md).

Telemetry is a dynamically sized shared page with a fixed ABI: magic, layout
version, session/page epoch, power-of-two capacity, graph revision, transport
snapshot, callback generation, and atomic meter slots. The writer brackets a
snapshot with an atomic generation seqlock; every payload field is itself
atomic, so the implementation never creates a Rust/C++ data race and does not
pretend a seqlock makes ordinary shared memory safe. The addon retries a
snapshot at most eight times and otherwise returns its last coherent value.
The existing 30 Hz renderer polling API reads this page synchronously and does
not generate normal request IPC.

The lower-frequency performance poll reads a separate addon-local diagnostic
snapshot. It reports normal/priority pending counts and timeouts, temporary
lease count/bytes, cumulative inline/shared normal-request packet and byte
traffic, event queue depth, telemetry epoch/revision/capacity and coherent-read
fallbacks, plus parameter-ring occupancy and saturation/fallback counters.
`AudioHostService` adds the age/generation tuple and helper-side egress active
count, queue depth/high-water, batch/blocking counts, both arena directions'
capacity/used/high-water/offers/busy/quarantine counts, and copied bytes from
the most recent priority heartbeat. Heartbeat reads atomics directly on the
priority ingress thread, so diagnostics remain available while Tokio, VST3, an
arena, or normal egress is saturated. These values are observational only and
are never written or sampled from the audio callback.

When a graph needs more meter slots, the helper creates a larger power-of-two
page and sends `TelemetryPageOffer(epoch, descriptor, generation)`. The addon
maps and verifies it, then acknowledges on the priority path. Publication
switches at a graph/block boundary; the old page stays mapped until the reader
releases it. There is no product-level track-count limit derived from the
initial 64 slots. Until the refactor lands, the existing offer still contains
`IpcSharedMemory` and macOS remains on its control fallback.

The parameter page is a 4096-entry cross-process SPSC ring. Electron
main/addon is the sole producer and helper is the sole consumer. Entries carry
session epoch, sequence, target kind, session-scoped runtime handle, parameter
ID, normalized bits, and gesture. The last 64 entries are reserved for
`Begin`/`End`; `Perform` values stop entering before that reserve and
`AudioHostService` coalesces the newest value per target/parameter. A hard-full
gesture boundary falls back to the priority channel. A transition from empty
to non-empty emits one `ParameterWake`. A helper restart changes the session
epoch, so stale ring entries and handles are ignored.

No IPC operation, serialization, channel send, or event construction occurs in
an audio callback.

### Runtime reconfiguration and shutdown

Changing advanced thread settings is one exclusive transaction. Electron main
rejects it while recording, finalization, recovery, or another configuration
restart is active. It synchronizes dirty plugin state, remembers device and
transport state, pauses transport, sends note-off/reset through the normal
engine stop path, closes native editors, and asks the helper to shut down. The
new helper must reach Ready, restore devices/plugins/full graph, and publish
the expected graph revision before the saved sample position and playing state
are restored. Settings are persisted only after success. Failure restarts with
the previous settings; only a failed rollback enters audio error. This planned
restart does not consume crash-recovery quota or mark a plugin suspicious.

Changing the project sample rate is a narrower engine transaction. The project
rate is the session clock used by DSP, transport, VST3 process context, MIDI,
metronome, and meters. cpal input and output streams remain at their respective
native default rates. Before publishing a differently rated graph, Electron
main rejects recording, snapshots and pauses transport, and rebuilds the same
device configuration with the new session rate. It scales the saved transport
position by `newRate / oldRate`, waits for the matching graph revision to
publish, seeks, and resumes only a previously playing transport. A failed
transition remains stopped and attempts to restore the previous project
configuration, session rate, and graph.

The input callback produces native frames into the bounded ring. The output
callback owns both preallocated rate boundaries:

```text
native input ring
  -> adaptive sinc SRC (native input rate -> session rate)
  -> playback graph / transport / VST3 / meters
  -> fixed-ratio sinc SRC (session rate -> native output rate)
  -> native output stream
```

The output converter is an exact bypass at equal rates. Meter time and transport
advance only by session frames rendered, not by native output frame count.
`clockSync` describes native input/output device-clock synchronization; a
separate diagnostic reports session/output conversion. Both converter delays
are included in engine and estimated round-trip latency.

Physical loopback measurement is a separate, user-triggered callback state
machine. It runs only while transport is stopped, validates 50 ms of quiet input,
silences the selected output to break any monitoring feedback route, emits a
fixed 13-sample matched probe, and correlates the selected input for up to three
seconds. Configuration and results cross the actor boundary; the callbacks only
read/write atomics and fixed arrays. The mock backend loops the selected output
into the selected input roughly one block later for deterministic integration and
desktop e2e coverage.

Normal shutdown stops new ingress, signals the async outbound actor, drains
queued responses and ordered events, waits for blocking sends, releases arena
mappings, then closes VST3/UI and joins the runtime. The addon waits up to two
seconds for the helper to exit by itself before using process termination.
Crash and watchdog paths may still terminate immediately.

## Playback graph lifecycle

### Build and publication

```text
project snapshot or semantic patch
  -> validated GraphUpdate revision
  -> VST3 registry resolves stable processor leases
  -> graph worker compiles routing, schedules, PDC, buffers
  -> EngineActor validates generation
  -> graph publication command enters SPSC ring
  -> callback swaps graph at a block boundary
  -> old graph enters retirement SPSC
  -> EngineActor destroys old graph off the callback
```

Project graph transport uses stable string IDs; array indices exist only in the
compiled helper graph. `GraphUpdate::Patch` carries ID-based upsert/remove
operations plus `base_revision` and new `revision`. The helper applies a patch
only when its current revision equals `base_revision`; otherwise it returns
`RevisionMismatch` and Electron retries its already-computed candidate as a
full `Replace`. One project command batch is one atomic patch.

`GraphAccepted` means compilation succeeded and the graph is queued for
block-boundary publication. `GraphPublished` is the later event that makes the
revision observable in telemetry. Large MIDI batches inside either a replace
or patch use shared attachments.

Every build has a monotonically increasing `GraphGeneration`. A newer build
cancels older queued builds. A completed stale build is discarded without
being published. Plugin instance IDs are stable across generations, so graph
changes do not unnecessarily destroy processors, controller state, or editor
windows.

The user-facing compiled-graph diagnostic uses a separate monotonic
`buildGeneration`, because one project `graphRevision` can be rebuilt after a
dynamic plug-in latency change or a software-monitoring setting change. The
worker creates an immutable typed snapshot with sources, channel/effect/Send
processing, width adapters, PDC and bypass compensation, Master/output sinks,
signal widths, and routing edges. The callback publishes that build number
beside the graph revision at the swap boundary. Control-side lookup keys the
snapshot by the published build number and never returns the newer queued
candidate.

The graph worker receives immutable build data and must not call a VST3
controller, access winit, start a device, or mutate the active graph. It
preallocates all callback data, including:

- channel and send buffers;
- VST3 audio buses, `ProcessData`, events, and parameter queues;
- PDC and bypass delay lines;
- meter scratch storage;
- MIDI schedule/chase state;
- tail propagation state;
- Tempo Map boundary indices.

If the callback cannot enqueue a retired graph because the retirement ring is
full, it may intentionally leak that graph rather than block or run its
destructor. This is a fatal control-plane health condition and must be surfaced.

### Signal order

The live graph order is:

```text
track source or VST3 instrument
  -> inserts
  -> pre-fader meter and sends
  -> fader
  -> post-fader sends
  -> pan
  -> Bus or Output
  -> global Master stage after each Output
```

The callback processes at most 4096 frames per VST3 call. A device callback
larger than that is split. Blocks are also split at Tempo Map markers and
sample-accurate MIDI or parameter event boundaries.

At each join and hardware Output, graph compilation calculates cumulative
plugin latency and adds preallocated delay to shorter paths. A VST3 latency
change marks the graph dirty; it does not rebuild inside the callback. Host
bypass preserves the plugin's compensated latency.

Finite tails continue until their declared sample count is exhausted. Infinite
tails continue until explicit stop. Tail state propagates downstream through
the graph rather than being managed independently per plugin.

### Time domains

Audio and MIDI deliberately use different time domains:

- audio clip placement and source duration use absolute sample frames;
- MIDI clips and Tempo Map markers use 960 PPQ musical ticks;
- the active Tempo Map is a stepwise, piecewise function;
- a MIDI clip moves with musical time after a tempo edit;
- an audio clip keeps its sample duration, while its displayed beat span is
  recomputed by piecewise integration across every crossed tempo segment.

Each VST3 process block receives coherent sample position, quarter-note
position, bar position, tempo, time signature, and play/record state. A block
must not contain two different tempo or time-signature values.

Seek and play perform note/controller chase. Stop sends note-off and reset
events before clearing delayed and tail state.

## Real-time callback contract

The cpal callback may:

- read and write preallocated slices and fixed-capacity collections;
- run the startup-allocated input/session/output sinc converters;
- perform DSP and VST3 processor calls;
- use atomics with documented orderings;
- consume or produce bounded SPSC rings;
- swap a prebuilt graph at a block boundary;
- update numeric meter, transport, xrun, and generation atomics.

The callback must not:

- allocate, resize, clone owned graphs, or format strings;
- acquire a mutex, read/write lock, condition variable, or async primitive;
- touch Tokio, winit, Electron, IPC, logging, or tracing;
- open, read, write, seek, decode, or inspect files;
- start, join, park, sleep, or yield an OS thread;
- construct plugin state or perform controller/editor operations;
- run a large destructor or close a plugin/module.

Realtime-safe code must not rely on “this normally does not allocate.” Its data
structure and capacity must make the bound explicit. Tests install the
repository allocation guard around the callback-like executor.

## Streaming and recording workers

There is no thread per clip. `BackgroundIoActor` owns a streaming registry keyed
by `StreamSourceId`. Each source has:

- its file format and reader state;
- two fixed-capacity atomic sample windows;
- active-window, requested-frame, generation, and shutdown atomics;
- at most one queued or running prefetch job.

The callback publishes demand through atomics and reads only the active window.
Workers fill the inactive window, verify the generation, then publish it with a
release store. A seek increments the generation; late results from the old
generation are ignored.

The worker supervisor creates:

- one recording lane, always reserved for draining the recording SPSC;
- `clamp(available_parallelism - 2, 1, 4)` general workers.

General jobs are ordered by:

1. imminent streaming underrun;
2. first window after seek;
3. graph/PDC build;
4. waveform and cache maintenance.

The recording lane owns the file writer and sequential recording state.
Callback ring overflow increments dropout frames and does not block. Stop first
disables the recording tap, then drains the ring, finalizes the file, updates
pending-recording recovery metadata, and returns the terminal result.

Adding clips must increase registry state and job volume, not the number of
threads.

## VST3 and window threading

`vst3-host-sys` generates target ABI bindings directly from the pinned VST3
SDK 3.8.0 headers. `vst3-host` owns COM references, module lifetime, class
enumeration, component activation, stereo sample32 block processing, latency,
tail queries, parameter/state exchange, controller connections, and editor
interfaces. Catalog discovery prefers `moduleinfo.json` (no binary load). When
that is absent, or when the moduleinfo lists an ARA Main Factory Class, a soft
`yadaw-vst3-probe --soft` factory enumeration opens the module without
instantiating processors. Deep processor probing remains available for built-in
validation and insert-time activation. Descriptors are cached in
`userData/plugin-catalog.json` with per-bundle mtime/size fingerprints: startup
awaits soft rediscovery before the workspace opens (reusing unchanged results
and retrying quarantined modules), while a manual Rescan forces lightweight
rediscovery of every bundle. There is no production C++ bridge or bridge path
argument.

Bindgen types follow the target C ABI and must not be papered over with
hardcoded Rust primitives at call sites:

- `TUID` / `int8` / `char8` are `c_char` (signedness varies by target). Use
  `TUID` and `compat::tuid_byte` instead of `[i8; 16]` or `*const i8`.
- C++ unscoped enum constants may bind as signed (`c_int` / `i32`) or unsigned
  (`u32`) depending on the target toolchain. Steinberg fields and parameters
  use typedefs such as `int32`, `uint32`, `MediaType`, and `BusDirection`. Cast
  enum constants to the **destination** typedef through `compat::as_int32`,
  `compat::as_uint32`, `compat::as_media_type`, `compat::as_bus_direction`, or
  `compat::process_context_state` (via `compat::BindgenEnum`) — never assume
  the enum constant type or flip platform-specific bare casts.
- Windows `COM_COMPATIBLE` TUID byte order and hand-written
  `extern "system"` vtables remain intentional ABI differences; keep them in
  `iid` / `abi`, separate from the typedef facade.

VST3 component/controller and processor ownership is split deliberately:

- controller, state/UI coordination, `IComponentHandler`, `IPlugView`, and
  `IPlugFrame` remain on the winit main thread;
- the configured processor half is leased to one active playback graph and is
  `Send` but not `Sync`;
- parameter input/output and latency notifications cross the boundary through
  bounded queues or atomics.

The Tokio control actor writes a capacity-64 mailbox and wakes winit through
`EventLoopProxy`. Winit drains at most 16 requests per wake and wakes itself
again while work remains, so plug-in traffic cannot starve native window
events.

The native UI context outlives the complete winit-owned VST3 runtime. On
Windows it calls `OleInitialize` before the first module load, because
`InitDll` can synchronously initialize VSTGUI and create its WIC factory.
Initializing OLE only when the first view is attached is too late: the module
would retain a null graphics factory for its lifetime. On macOS, module load
uses `CFBundle` + mandatory `bundleEntry`/`bundleExit` (see Steinberg
`module_mac.mm`); raw `dlopen` of `Contents/MacOS/<stem>` is insufficient
because many bundles use a different executable name and require the bundle
ref for resource lookup.

There is one winit top-level editor per plug-in instance. Reopening focuses it.
iced 0.14 and its WGPU renderer draw the toolbar and parameter list without
starting another event loop. Native mode creates a platform child below the
toolbar: an HWND with child/clip styles, an NSView, or an X11 window carrying
XEmbed information. Closing uses this order:

```text
IPlugView::removed
  -> IPlugView::setFrame(null)
  -> release view
  -> destroy platform child
  -> destroy winit window
  -> release controller/component
```

An unload removes the instance from the live UI registry immediately. Because
an already-published audio graph may still contain its `Send + !Sync`
processor lease, the controller/component allocation moves to a UI-owned
retirement list. Helper shutdown stops the audio engine first and then drops
that retirement list, preserving this ordering without exposing an unloaded
instance to later editor or parameter commands.

Switching to parameter mode performs the same detach sequence through child
destruction but keeps the winit window. Switching back creates and attaches a
fresh view. Attach failure and absent editors fall back in place without
overwriting the saved native preference. Wayland always uses this fallback
until `IWaylandHost` is implemented.

The iced/parameter scale is `winit monitor scale × user zoom`. Windows and X11
send that same factor to `IPlugViewContentScaleSupport`; AppKit already applies
the backing scale, so macOS sends only user zoom. Windows/X11 `ViewRect` values
are physical pixels and AppKit values are logical points. A plug-in that
rejects the scale interface keeps its native pixel size—there is no bitmap
stretch—while iced still scales and reports the limitation.

`IPlugFrame::resizeView` may synchronously reenter during `attached`. Its frame
callback uses stable external window/container cells, applies the requested
size, and calls `onSize` without holding a mutex or borrowing the host's
`PlugView`. User-driven resize runs `checkSizeConstraint` before resizing the
child and notifying the view.

## Failure and shutdown

The crash marker records graph generation, plugin index, and one of:

```text
initialize | restore | process | editor | state-save | clean
```

The watchdog observes independent IPC, Tokio-dispatch, winit-dispatch, and
audio-callback generations. During playback, two seconds without relevant
progress is a hang.

Recovery policy is:

1. terminate the helper;
2. close renderer-side editor state;
3. identify the suspect from the marker;
4. bypass that effect or mute that instrument;
5. if the marker is inconclusive, bypass all third-party instances;
6. restart once and replay the last acknowledged graph;
7. restore the restart allowance after five stable seconds.

Orderly shutdown:

1. send idempotent `Shutdown` through the priority channel and stop accepting
   ordinary protocol work;
2. cancel graph and streaming generations;
3. stop transport and send MIDI reset;
4. disable and drain recording, then finalize the file;
5. stop cpal streams;
6. close VST3 editors on winit;
7. deactivate and release plugin instances;
8. drain retired graphs and stop background workers;
9. reject addon pending promises and discard stale session handles/pages;
10. close IPC channels and exit the winit event loop;
11. join response/event routers before egress threads, because routers own
    egress sender clones; reap the helper process last.

Shutdown is idempotent. Repeating it must not start new work or double-finalize
a recording.

## Required tests and review checks

Any playback-runtime change should cover the applicable items:

- multi-thread Tokio and LocalSet tests for actor ordering, timeout, cancellation, mailbox
  saturation, stale generations, and actor failure;
- tests proving 1, 32, and 256 streaming clips use the same thread count;
- seek-storm tests proving only the latest prefetch generation publishes;
- recording stress while streaming and rebuilding a graph;
- graph swap and retirement tests, including a saturated retirement ring;
- allocation/lock/I/O guards around the callback-like block executor;
- PDC, bypass latency, finite/infinite tail, Tempo boundary, event offset, MIDI
  chase, and VST3 fixture tests;
- helper crash/hang recovery and graph replay tests;
- local Playwright coverage through the mock audio backend.

During review, reject changes that:

- add a second mutable owner for a runtime domain;
- introduce an unbounded queue or an undocumented thread;
- access an actor-owned object directly instead of through its handle;
- make callback safety depend on Tokio, a lock, filesystem state, or Electron;
- publish a graph or streaming window without generation validation;
- save or restore plugin state from the callback.

For a local transport baseline, run:

```sh
mise exec -- cargo run -p yadaw-ipc-transport --bin yadaw-ipc-benchmark --release
```

It launches a child process and reports 128-byte sequential RTT, the first
bidirectional 4 MiB arena mapping, warm sequential shared-reference throughput,
1/4/8/16 in-flight saturation, MessagePack control-body size, region-offer
count, and shared telemetry read rate. The warm numbers are explicitly logical
referenced bytes: this transport-only binary does not cross the Node boundary
and therefore does not perform the addon's intentional arena-to-Buffer copy.
Use the desktop performance benchmark for end-to-end addon/helper bandwidth.
This remains a developer benchmark rather than a GitHub Actions gate.
