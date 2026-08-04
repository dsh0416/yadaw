# Playback runtime

Playback runs inside the `@heron/dsp-node` dynamic library loaded by Electron
main. `EmbeddedAudioHost` composes the existing engine, plug-in, background,
and editor actors with bounded in-process channels.

## Control flow

1. Renderer sends a typed command through `window.heron`.
2. Main validates resource epochs and converts the command to the native wire
   protocol.
3. `AudioHostRuntime.request()` decodes it and submits it to the embedded
   control actor.
4. The actor prepares or commits engine/plug-in state away from the callback.
5. The typed response returns through the same N-API task.

Graph mutations retain prepare/activate/abort and revision checks because they
protect state consistency, not because another audio process exists. Resource
epochs still prevent stale renderer commands from targeting replaced project
or native resources.

## Data paths

- Control requests: bounded Tokio channel.
- Parameter changes: dedicated bounded direct queue with explicit full/stale
  outcomes.
- Telemetry: direct snapshot read from the engine.
- Host events: ordered in-process drain into Electron main.
- Binary plug-in and graph state: inline local payloads.

No shared-memory pages, arenas, attachment leases, process framing, or egress
workers participate in playback.

## Lifetime and failure

The runtime is created once during application startup and closed during app
shutdown. A diagnostic heartbeat observes control/UI/callback progress but
does not restart the runtime. A fatal native crash follows Electron's normal
application crash/relaunch behavior, eliminating the old half-alive
renderer/helper combinations.

VST3 UI work is queued by Tokio and drained in bounded turns by Electron main.
Electron owns native editor top-level windows while Rust owns the attached VST3
child view; shutdown always detaches the child before destroying its parent.
Audio-device callbacks remain isolated from JavaScript, UI, filesystem work,
allocation, and blocking synchronization.
