# ADR-0001: Embed the native audio runtime

- Status: Accepted
- Date: 2026-08-08
- Owners: project maintainers
- Related: `agents/docs/architecture.md`

## Context

Heron previously carried concepts for a supervised helper audio process,
transport clients, shared-memory exchange, watchdog behavior, and crash
reconciliation. The product also needs native VST3/ARA editor and document-model
ownership on the platform application thread. Maintaining two runtime models
made mutation outcome, resource lifetime, and recovery ambiguous.

## Decision

Electron main owns one `@heron/dsp-node` instance in its process. The addon owns
the embedded control runtime, audio engine, device streams, plug-in actors, and
telemetry. Renderer/main remains the only application-owned process boundary.
The MessagePack envelope at main/native is a local N-API ABI, not IPC.

Fatal native or in-process plug-in failure may terminate Electron main. Ordinary
failures return typed results. Relaunch and persisted project recovery handle
fatal failure; Heron does not reconstruct an audio helper or claim uninterrupted
audio after such a crash.

## Alternatives rejected

### Supervised audio helper process

Isolation could keep the renderer alive after a crash, but it requires process
supervision, mutation reconciliation, shared or copied real-time data, native
window coordination, and an ARA ownership model that the current product cannot
preserve safely.

### Per-plug-in process isolation

This could contain some plug-in crashes, but immediately conflicts with current
ARA document/controller ownership and would be a large new runtime architecture
rather than Live hardening.

## Consequences

- Main/native calls have an explicit local ABI and bounded control queues.
- Plug-in crashes can restart the whole application.
- Live reliability focuses on prevention, legal bypass states, committed-data
  recovery, and clear relaunch behavior rather than false continuity.
- Helper-process supervision, OS shared memory, watchdogs, and restart
  reconciliation must not reappear without a superseding ADR.

## Verification

Architecture tests prevent renderer/preload imports of the addon. Native tests
exercise terminal request results, bounded queues, graph publication, and
recovery states. Release tests include fatal-relaunch recovery evidence.

## Reconsider when

Reconsider only if a proven product requirement outweighs ARA ownership and
local-runtime simplicity and a complete transactional isolation design exists.
