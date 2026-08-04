# Architecture and real-time constraints

Heron is an Electron application with one native audio runtime embedded in the
Electron main process.

```text
Vue renderer
  -> typed window.heron preload API
  -> Electron main RPC handlers and application services
  -> @heron/dsp-node (.node dynamic library, same process)
       -> embedded Rust control runtime
       -> audio engine and cpal streams
       -> VST3 host and editor runtime
       -> direct telemetry and bounded parameter queue
```

There is no `heron-audio-host` executable, audio-host client addon, OS IPC
channel, shared-memory arena, watchdog, or helper restart coordinator. The
renderer/main Electron boundary remains a real process boundary; the
main/native boundary is N-API within one process.

## Ownership

- Renderer owns presentation and user intent. It never imports native addons.
- Preload exposes the narrow typed `window.heron` API.
- Electron main owns resource validation, project state, native runtime
  lifetime, and application policy.
- `@heron/dsp-node` owns `EmbeddedAudioHost`, its bounded Tokio control queues,
  audio engine, VST3 actors, and telemetry.
- The audio callback owns only real-time-safe state. It must not perform N-API,
  Electron IPC, filesystem I/O, allocation, logging, or blocking locks.

## Native control and UI events

Electron main sends MessagePack request envelopes to the addon to preserve one
typed Rust protocol and one response-validation path. This serialization is a
local N-API ABI, not an IPC transport. Binary payloads are inline; attachment
descriptors and shared-memory references are rejected.

The addon places control work on bounded in-process channels. N-API async tasks
wait outside the JavaScript thread. Parameter automation uses a separate
bounded direct queue, and telemetry is read directly from the engine snapshot.

VST3 editor windows remain thread-affine. Electron main calls `pumpEvents()` on
an unref'd short interval so winit work runs on the JavaScript/main thread
without blocking Electron's event loop.

## Failure model

An unrecoverable native crash terminates the Electron main process; it cannot
leave a live renderer talking to a dead audio helper. Ordinary request errors
remain typed results and do not destroy the runtime. Heartbeats provide
diagnostics only and never trigger graph/plugin/transport reconstruction.

Runtime worker limits are saved as preferences and applied on the next
application launch. Heron deliberately does not tear down and recreate the
embedded winit/audio runtime in a live process.

## Real-time rules

- Keep callback work bounded and allocation-free.
- Use lock-free snapshots or bounded non-blocking queues at callback edges.
- Build graphs, load plug-ins, access files, and encode responses off callback
  threads.
- Never hold a callback-visible lock across N-API, Electron, device, plug-in,
  or filesystem calls.
- Overflow and stale-generation outcomes must be explicit and observable.
