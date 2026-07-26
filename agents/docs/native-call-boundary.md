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
  See also `docs/architecture.md`.

Tests may mock `window.yadaw`. E2E tests may call it to inspect native state,
but product behavior should normally be exercised through the UI.

## Ownership and concurrency

| API area | Owner store | Concurrency rule | Failure behavior |
| --- | --- | --- | --- |
| Engine info and gain preview | `engine` | latest result | retain error in store |
| Audio hosts and devices | `audioPreferences` | latest-wins generation | clear stale device lists |
| Audio engine lifecycle and telemetry | `audioRuntime` | exclusive lifecycle; latest telemetry | main state is authoritative |
| Desktop lifecycle subscription | `lifecycle` | monotonic revision | ignore older events/snapshots |
| Project lifecycle and named persistence operations | `project` | exclusive lifecycle | rollback to prior stable state |
| Mixer graph and history | `mixer` | FIFO committed mutations; coalesced previews | rollback/reload before next mutation |
| Transport | `transport` | FIFO state commands; coalesced seek; latest polling | ignore stale snapshots |
| Recording and recovery | `recording` | exclusive lifecycle | return to idle and retain recoverable media |
| Cross-domain studio operations | `studioWorkflow` | explicit awaited sequence | stop at the first failed guard/action |
| Waveforms | `waveform` | cached/latest request generation | stale results are discarded |
| Settings | `applicationSettings` | store-owned actions | optimistic changes roll back |
| Operations | `operations` | one application-owned subscription | main events are authoritative |
| Benchmark | `audioBenchmark` | single running benchmark | retain terminal report/error |
| System telemetry | `systemPerformance` | latest-wins polling | retain last usable snapshot |

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
normal-request packet and byte traffic. This read must stay local to
Electron/addon atomics and mutexes; performance monitoring must never send a
diagnostic request to the helper it is trying to observe.

Large `Uint8Array` values remain ordinary values at this boundary. The native
addon decides whether to inline or attach them and always returns an ordinary
Node Buffer after one validated copy. Renderer, preload, and project database
code must not retain a shared-memory handle or lease ID.

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
8. Classify its transport: small control MessagePack, temporary shared blob,
   sampled telemetry, SPSC parameter command, or stable-ID graph patch. Do not
   place a large byte vector or high-frequency observation on normal request
   IPC.
9. Add store tests, main guard/transition tests, and a reversed-completion race
   test when the operation is asynchronous.
10. Run the renderer boundary test and the repository validation path.

Any production exception to this boundary requires an explicit update to this
document and `AGENTS.md`; a local bypass is not acceptable.
