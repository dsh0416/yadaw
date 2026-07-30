# Native Call Boundary

This document defines the ownership and ordering rules for calls that cross
from the Vue renderer into Electron main or the native audio addon. These are
correctness and architecture rules, not merely code-organization preferences.

## Boundary

```text
Vue component or composable
  -> Pinia action
  -> window.yadaw typed preload API
  -> validated Electron main handler
  -> authoritative main-process service/lifecycle coordinator
      ├─ live playback -> @yadaw/audio-host-client -> ipc-channel -> audio-host
      └─ offline tools -> @yadaw/dsp-node
```

- Production renderer code may invoke or subscribe to `window.yadaw` only from
  `apps/desktop/src/renderer/src/stores/**/*.ts`.
- Components, views, routers, and composables express user intent through store
  actions and consume reactive store state. They never call the preload API.
- Preload only maps named, typed methods and subscriptions to IPC. It owns no
  business state and performs no workflow orchestration.
- Pinia is the renderer projection, not a security boundary. Main validates the
  sender, payload, lifecycle transition, and cross-domain preconditions for
  every request.
- Only Electron main may import `@yadaw/audio-host-client` or
  `@yadaw/dsp-node`. The renderer and preload may not load either addon
  directly.
- `audio-host-client` owns the live helper lifecycle, typed cross-process
  protocol, watchdog, and restart coordination. `dsp-node` owns offline tools
  only and must not regain a cpal stream, transport, recording session,
  playback graph, or VST3 instance.
- IPC, filesystem work, Vue reactivity, allocation, and blocking synchronization
  remain outside real-time audio callbacks. The normative graph, actor, worker,
  and thread rules are in [Playback runtime architecture](playback-runtime.md).
  See also [Architecture and real-time constraints](architecture.md).

Tests may mock `window.yadaw`. E2E tests may call it to inspect native state,
but product behavior should normally be exercised through the UI.

## Ownership and concurrency

| API area                                           | Owner store           | Concurrency rule                                    | Failure behavior                            |
| -------------------------------------------------- | --------------------- | --------------------------------------------------- | ------------------------------------------- |
| Engine info and gain preview                       | `engine`              | latest result                                       | retain error in store                       |
| Audio hosts and devices                            | `audioPreferences`    | latest-wins generation                              | clear stale device lists                    |
| Audio engine lifecycle and telemetry               | `audioRuntime`        | exclusive lifecycle; latest telemetry               | main state is authoritative                 |
| Desktop lifecycle subscription                     | `lifecycle`           | monotonic revision                                  | ignore older events/snapshots               |
| Project lifecycle and named persistence operations | `project`             | exclusive lifecycle                                 | rollback to prior stable state              |
| Mixer graph and history                            | `mixer`               | FIFO committed mutations; coalesced previews        | rollback/reload before next mutation        |
| Transport                                          | `transport`           | FIFO state commands; coalesced seek; latest polling | ignore stale snapshots                      |
| Recording and recovery                             | `recording`           | exclusive lifecycle                                 | return to idle and retain recoverable media |
| Compiled effect-graph diagnostics                  | `compiledEffectGraph` | latest-wins one-hertz polling while dialog is open  | explicit empty/error state; manual retry    |
| Cross-domain studio operations                     | `studioWorkflow`      | explicit awaited sequence                           | stop at the first failed guard/action       |
| Waveforms                                          | `waveform`            | cached/latest request generation                    | stale results are discarded                 |
| Settings                                           | `applicationSettings` | ordinary patches; exclusive helper restart          | persist only after restart; rollback config |
| Operations                                         | `operations`          | one application-owned subscription                  | main events are authoritative               |
| Benchmark                                          | `audioBenchmark`      | single running benchmark                            | retain terminal report/error                |
| System telemetry                                   | `systemPerformance`   | latest-wins polling                                 | retain last usable snapshot                 |

The number of IPC channels is not reduced by creating an untyped command bus.
Named, narrow methods remain preferable because they preserve validation and
capability boundaries.

## Lifecycle rules

Project, audio, and recording use discriminated-union states shared through
`@yadaw/contracts`. Main transitions first and publishes revisioned lifecycle
events. Pinia may transition immediately for UI feedback, then reconciles with
main and ignores any event older than the last accepted revision.

Main also owns cross-domain guards. In particular, an active recording blocks
project save/close, audio stop/reconfiguration, renderer transport commands,
project writes, mixer reloads, and mixer structural edits. Explicitly allowed
real-time parameter changes may continue.

High-frequency meter, transport-position, performance, and waveform samples
are observations rather than lifecycle states. They use sampling and stale
response suppression and never run inside the audio callback.

Live meter and transport snapshots are an exception to the usual asynchronous
native-call shape: Electron main synchronously reads the addon-owned coherent
telemetry page, and the existing preload methods return that observation. They
must not be reimplemented as 30 Hz request/reply IPC. Plugin and mixer preview
parameters similarly use the addon-owned SPSC producer; only gesture-boundary
fallbacks and wake/lifecycle messages use priority IPC.

The one-second `systemPerformance` sample also includes an audio IPC diagnostic
snapshot. `AudioHostService` combines its cached priority-heartbeat generations
with addon-local counters for pending requests, leases, event depth, telemetry
capacity/fallbacks, parameter-ring pressure, and cumulative inline/shared
normal-request packet and byte traffic, resolved Tokio thread counts, egress
queue/activity, and both persistent bulk-arena directions. This read must stay local to
Electron/addon atomics and mutexes; performance monitoring must never send a
diagnostic request to the helper it is trying to observe.

Large `Uint8Array` values remain ordinary values at the renderer/preload
boundary. Electron main replaces values above 64 KiB with attachment indexes
before MessagePack encoding and calls the addon with `{ body, attachments }`.
The addon copies attachments synchronously into its persistent arena and always
returns ordinary Node Buffers after one validated copy. Renderer, preload, and
project database code must not retain a shared-memory handle, region ID,
generation, or lease ID.

Large structured MIDI arrays are a native-wire exception to MessagePack
materialization. Electron still submits the same typed graph request, but the
native transport externalizes large note/event batches into the fixed MIDI ABI
documented in `playback-runtime.md`. The helper borrows validated records from
the mapping while compiling the native graph and only creates an owned copy for
the retained graph-patch snapshot. This optimization is contained below the
preload API and does not expose shared-memory lifetimes to JavaScript.

Live MIDI devices are another native-only boundary. Renderer code consumes
`midiInputSnapshot`, subscribes to the named MIDI runtime event, and submits
validated `configureMidiInput` preferences; it never imports `midir`, the
native addon, port handles, or queue storage. Electron main persists the unique
clock-source identity and timing offsets only after the helper accepts them,
then restores the same preferences after a helper restart. Per-track route
identity remains project data and is compiled into numeric keys before the
graph reaches the callback.

The `midir` callback may only copy a timestamp and bytes into the fixed
16,384-message/4 MiB SysEx ingress. Parsing, device names, hot-plug polling,
diagnostics, and journal I/O stay on non-real-time actors. The audio callback
may drain the preallocated queue, scan preallocated scratch, calculate sample
offsets, update atomics, and enqueue fixed-capacity VST3 events or parameter
points. It must not allocate, deallocate, lock, format, touch the filesystem,
or emit IPC. A dropped event that could strand a note sets an atomic panic
consumed at the next block.

`configureAudioHostRuntime` is intentionally separate from the ordinary
settings patch API. The `applicationSettings` store owns its loading/error
state; main owns the recording/recovery guard and the complete helper
restart/restore/rollback transaction. The new settings file is written only
after the replacement helper has published the restored graph.

`setSoftwareMonitoringEnabled` is also a named transaction rather than a
generic settings patch. Main rejects it during recording, helper
reconfiguration, or another exclusive operation. With an open project it
serially recompiles and waits for block-boundary publication before persisting
the setting; a persistence failure republishes the prior graph. Without an open
project it only persists the setting. The project-owned `inputMonitoring`
selection is not cleared when the global setting is disabled.

`compiledAudioGraphSnapshot` is read-only and low frequency. The helper assigns
an independent build generation to each successful compilation and stores an
immutable typed snapshot off the real-time path. The callback publishes the
build generation atomically with the graph swap; a query resolves that
published generation and therefore never returns a queued graph. The renderer
store polls only while its Help dialog is open, suppresses stale results, and
distinguishes no project/no published graph from helper failure.

Plug-in editor preferences follow a similarly narrow path. Renderer code only
calls `openPluginEditor(instanceId)` through the plug-in Pinia store. Electron
main resolves the class-ID preference and sends it to `audio-host`; the helper
owns both native and parameter editor windows. A
`PluginEditorPreferenceChanged` host event returns mode and zoom changes for an
atomic, class-ID-keyed settings merge. `pluginEditors` is deliberately excluded
from the generic settings patch API, and no Vue component may create an
in-renderer generic parameter dialog.

Window ownership is also confined to this native boundary. Electron main passes
its native HWND directly to `audio-host-client` during Windows helper startup;
the handle is never serialized into renderer IPC or exposed through preload.
The helper uses it only to create owned winit editor windows without a second
taskbar entry. Electron remains the sole tray/Dock identity owner.

## Adding a native call

Before adding or changing a native call:

1. Add a serializable request/result to `@yadaw/contracts` and a named preload
   method. Do not add a stringly typed generic command.
2. Assign exactly one owner Pinia store and update the table above.
3. Validate the sender and all untrusted payload fields in Electron main.
4. Route live playback through `audio-host-client`; route only offline work
   through `dsp-node`. Do not add a temporary direct helper or plugin call.
5. Choose and document one concurrency rule: exclusive state transition, FIFO,
   latest-wins, coalesced, or sampled telemetry.
6. Define the stable state after success, cancellation, and failure. Main must
   reject illegal transitions even if the renderer bypasses its store guard.
7. If the operation reaches the playback helper, assign an actor owner,
   bounded-mailbox behavior, deadline, cancellation behavior, and confirm that
   no part executes in the real-time callback.
8. Classify its transport: small control MessagePack, persistent-arena
   attachment,
   sampled telemetry, SPSC parameter command, or stable-ID graph patch. Do not
   place a large byte vector or high-frequency observation on normal request
   IPC.
9. Add store tests, main guard/transition tests, and a reversed-completion race
   test when the operation is asynchronous.
10. Run the renderer boundary test and the repository validation path.

Any production exception to this boundary requires an explicit update to this
document and `AGENTS.md`; a local bypass is not acceptable.
