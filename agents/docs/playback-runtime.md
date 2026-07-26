# Playback Runtime Architecture

This document is the agent-facing specification for YADAW's playback graph,
threads, asynchronous control plane, background workers, and VST3 runtime. It
defines ownership and real-time invariants for the VST3/Tokio migration.

The helper control plane now uses `ipc-channel`, a dedicated current-thread
Tokio runtime, bounded actor mailboxes, and a winit process main thread.
Streaming clips are cooperatively serviced by a fixed pool of two to four
background lanes; there is no production prefetch thread per clip. Graph
construction is still synchronous inside the VST3 actor and must move to the
supervised graph worker described below. The old length-prefixed MessagePack
transport remains only as a compatibility entry point for standalone tools.
Update this document in the same change whenever an ownership boundary or
concurrency rule changes.

## System shape

```text
Vue / Pinia
  -> window.yadaw
  -> Electron main services
  -> audio-host-client (.node)
       ├─ request_id -> JsDeferred response router (up to 256 in flight)
       ├─ independent normal, priority-heartbeat, and event channels
       ├─ shared telemetry reader and parameter-ring producer
       ├─ helper lifecycle and lease ownership
       └─ servo/ipc-channel
            |
            v
       yadaw-audio-host process
       ├─ process main thread: winit + VST3 controller/editor/windows
       ├─ yadaw-control: current-thread Tokio runtime + actors
       ├─ IPC ingress/egress bridge threads
       ├─ cpal-owned real-time callback threads
       └─ supervised background workers
            ├─ one recording lane
            └─ bounded general workers for streaming and graph builds
```

`dsp-node` remains an Electron-main-only addon for offline audio utilities,
MIDI parsing, database audio helpers, and benchmarks. It does not own a live
device, transport, recording session, playback graph, or plugin instance.

## Ownership map

| Domain | Sole owner | Other access |
| --- | --- | --- |
| Helper request lifecycle | `ProtocolActor` | typed handles and one-shot replies |
| Audio devices and cpal streams | `EngineActor` | atomic runtime snapshots |
| Active playback graph | cpal output callback | SPSC graph commands |
| Graph construction and PDC calculation | supervised graph worker | immutable build input |
| Retired graphs | control side of `EngineActor` | callback pushes to retirement SPSC |
| VST3 controller and editor | winit main thread / `Vst3Actor` | bounded mailbox |
| VST3 processor | active playback graph | stable processor registry/lease |
| Transport position while running | audio callback | atomic snapshot |
| Streaming file readers | background worker registry | atomic window controls |
| Streaming sample windows | source state shared with callback | double-buffered atomic publication |
| Recording file writer | dedicated recording lane | recording SPSC consumer |
| Plugin/project persistence | Electron main | explicit state-save requests |

An object must not have two mutable owners. A cloneable handle contains a
sender, immutable metadata, or atomics; it is not a second owner of the domain.

## Control runtime and actors

The helper has exactly one Tokio runtime. It runs on the dedicated
`yadaw-control` thread using a current-thread scheduler and a `LocalSet`. The
runtime stays inside one long-lived `block_on`; winit is never used to
periodically poll Tokio.

Production helper code must not use:

- a Tokio multi-thread runtime;
- `tokio::spawn_blocking` or `tokio::fs`;
- an unbounded Tokio channel;
- an ad hoc worker thread outside the runtime/bootstrap/worker modules;
- a mutex or read/write lock guard held across `.await`.

The control-plane actors are:

| Actor | Mailbox capacity | Responsibilities |
| --- | ---: | --- |
| `ProtocolActor` | 256 | version validation, request IDs, deadlines, routing |
| `EngineActor` | 64 | devices, streams, transport, graph publication, meters |
| `Vst3Actor` | 64 | instances, parameters, state, editor, latency events |
| `BackgroundIoActor` | 128 | recording, streaming registry, graph and waveform jobs |
| `OutboundActor` | 256 | replies and coalesced runtime events |

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

Cross-process messages use protocol v2 over `servo/ipc-channel`. The outer
value is `WirePacket { body, regions }`: `body` is a bounded MessagePack
request/reply/event and `regions` contains zero or more
`IpcSharedMemory` handles. Protocol v1 is intentionally rejected because addon
and helper are a lockstep application resource.

```text
WirePacket
  body: ControlRequest | ControlResponse | PriorityRequest | PriorityResponse | HostEvent
  regions: IpcSharedMemory[]
```

Binary fields use `BinaryPayload::Inline` through 64 KiB and
`BinaryPayload::Shared` above 64 KiB. Shared references contain the packet
region index, checked offset and length, XXH3-64 checksum, and lease ID.
Component/controller state, waveform peaks, raw MIDI/SysEx, and encoded large
MIDI batches use this path. The addon validates and copies a received temporary
blob exactly once into an ordinary Node Buffer; Electron never owns an external
Buffer backed by a cross-process mapping.

Attachments in one packet are 8-byte aligned and packed into as few regions as
possible. A blob and a packet are each limited to 64 MiB. Each side permits at
most 256 outstanding temporary leases and 512 MiB. The sender retains a
mapping until `ReleaseLeases`; a 30-second expiry is a transport fault and
releases the sender copy. Session close releases every temporary and persistent
lease. Telemetry pages and the parameter ring are persistent session leases and
do not use the temporary timeout.

Bootstrap transfers these independent paths:

```text
normal requests  -> normal replies
priority requests -> priority replies
events
telemetry page (persistent)
parameter SPSC ring (persistent)
session epoch
```

The addon response router owns the blocking normal receiver and resolves
`request_id -> JsDeferred` in any order. Deadlines are scanned by the router;
helper exit rejects all pending promises at once. Event and priority response
routers have separate receivers. No request occupies libuv's worker pool while
waiting for IPC.

`ipc-channel` receive operations are blocking and its internal send queue is
not the application's backpressure mechanism. Each process therefore has
supervised blocking ingress/egress bridge threads around bounded actor
mailboxes. Normal ingress uses `try_send` into the 256-entry Tokio protocol
mailbox and returns `Busy` when saturated. Priority ingress answers heartbeat
directly from liveness atomics; it never waits for Tokio, VST3, graph building,
or the normal mailbox. Shutdown, lease release, parameter wake, and gesture
boundary fallbacks use its reserved mailbox. Tokio actors enqueue replies to a
bounded outbound mailbox; only the egress bridge calls blocking
`ipc-channel::send`.

Heartbeat reports independent IPC-receive, Tokio-dispatch, winit-dispatch, and
audio-callback generations. This makes a control-runtime hang distinguishable
from a plugin editor hang or audio callback stall.

### Persistent real-time pages

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
`AudioHostService` adds the age and generation tuple from the most recent
priority heartbeat. These values are observational only and are never written
or sampled from the audio callback.

When a graph needs more meter slots, the helper creates a larger power-of-two
page and sends `TelemetryPageOffer(epoch)`. The addon maps it and acknowledges
on the priority path. Publication switches at a graph/block boundary; the old
page stays mapped until the reader releases it. There is no product-level
track-count limit derived from the initial 64 slots.

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
and tail queries. The production scanner uses the Rust
`yadaw-vst3-probe` binary. Parameter/state/event/editor support is still
provided by the transitional bridge while those interfaces move into
`vst3-host`; do not add new features to that bridge.

VST3 component/controller and processor ownership is split deliberately:

- controller, state/UI coordination, `IComponentHandler`, `IPlugView`, and
  `IPlugFrame` remain on the winit main thread;
- the configured processor half is leased to one active playback graph and is
  `Send` but not `Sync`;
- parameter input/output and latency notifications cross the boundary through
  bounded queues or atomics.

The Tokio `Vst3Handle` writes a bounded mailbox and wakes winit through
`EventLoopProxy`. Winit drains a bounded batch per wake so plugin traffic cannot
starve native window events.

There is one native window per plugin instance. Reopening focuses it. Closing
uses this order:

```text
IPlugView::removed
  -> IPlugView::setFrame(null)
  -> release view
  -> destroy winit window
```

Win32, AppKit, and X11 use their native raw window handles. Wayland uses the
generic parameter panel until `IWaylandHost` is implemented.

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

- current-thread Tokio tests for actor ordering, timeout, cancellation, mailbox
  saturation, stale generations, and actor failure;
- tests proving 1, 32, and 256 streaming clips use the same thread count;
- seek-storm tests proving only the latest prefetch generation publishes;
- recording stress while streaming and rebuilding a graph;
- graph swap and retirement tests, including a saturated retirement ring;
- allocation/lock/I/O guards around the callback-like block executor;
- PDC, bypass latency, finite/infinite tail, Tempo boundary, event offset, MIDI
  chase, and VST3 fixture tests;
- helper crash/hang recovery and graph replay tests;
- local Playwright coverage through the virtual audio backend.

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

It launches a child process and reports inline/shared round-trip throughput at
the 64 KiB threshold, a 256-request pipeline, and shared telemetry read rate.
It is intentionally a developer benchmark rather than a GitHub Actions gate.
