# IPC v2 Delivery Verification

This record accompanies the breaking IPC protocol version 2 rollout. Renderer,
preload, Electron main, project workers, the native addon, and the audio helper
must ship from the same build. Native bootstrap does not negotiate a version or
build fingerprint; the packaged helper heartbeat smoke test is the lockstep-build
guard. Version 1 compatibility is intentionally absent at the application IPC
boundary.

## Logical commit sequence

The single-PR history is intentionally unsquashed:

1. `0526f90` — normative cross-process contract and initial Rust gates.
2. `cbb6141` — v2 contracts, envelopes, resources, and wrappers.
3. `db5ead7` — Main resource, operation, and application-state kernel.
4. `3015393` — Rust graph prepare/activate/abort primitives.
5. `18f88ae` — project lifecycle vertical migration.
6. `3a21cbc` — project commands, durable save, and graph deployment.
7. `82bfd83` — audio engine and transport resources.
8. `bd583f8` — recording transactions and recoverable media.
9. `8b6b4a5` — plug-in, MIDI, and real-time resource generations.
10. `c354ff8` — settings, offline tools, diagnostics, and remaining reads.
11. `6ae5e30` — final typed-error gates, startup guards, and legacy cleanup.
12. This documentation-only delivery record.

## Recovery guarantees

- Project create/open candidates are isolated. Failure before the Main commit
  drops or quarantines only that candidate; the next healthy open receives a
  fresh worker epoch and resource generation.
- Project-worker database commit is authoritative. A lost response is reconciled
  by `operationId`; native deployment is rebuilt from the committed desired
  graph rather than an attempted graph.
- Archive save/save-as and recording finalization retain durable recovery
  journals. Unknown outcomes are reconciled instead of blindly replayed.
- Helper restart invalidates its resource epoch and restores only committed
  desired state. Stale graph, plug-in, parameter, MIDI, and telemetry handles
  cannot mutate the replacement runtime.
- Dirty project close requires an explicit `save`, `discard`, or `cancel`
  disposition. Cancel leaves the committed project open; discard closes it
  through the same resource transaction.
- Pinia is a revisioned projection. Event gaps or epoch changes trigger
  bootstrap reconciliation and reset domain revision guards before accepting
  the replacement snapshot.

## Validation record

Validated on Windows on 2026-07-31 with the repository-locked Node 26.5.1,
pnpm 11.18.0, and Rust toolchain:

```sh
pnpm check
pnpm --filter @yadaw/desktop test:e2e -- \
  e2e/project-lifecycle.spec.ts \
  e2e/round-trip-latency.spec.ts \
  e2e/unsaved-close.spec.ts
cargo clippy \
  -p yadaw-audio-host \
  -p yadaw-audio-host-client \
  -p yadaw-ipc-transport \
  -p yadaw-dsp-runtime \
  --all-targets -- -D warnings
```

The repository gate passed formatting, ESLint, configuration checks, the full
Rust workspace tests and Clippy, benchmark compilation, NAPI builds, TypeScript
checks, 538 desktop unit tests, 50 contract tests, project-database integration
tests, real-time allocation invariants, and design-system checks. The three
Playwright recovery/performance specs passed in one rebuilt application run.

The unsaved-close spec commits a project mutation, observes the authoritative
dirty snapshot and warning affordance, opens the Save/Discard/Cancel dialog,
verifies Cancel preserves the studio, and then verifies explicit discard closes
the project.

## Performance comparison

The release `yadaw-ipc-benchmark` was run sequentially on the same machine
against pre-refactor `ae33e10` and current `6ae5e30`. A temporary detached
copy of the unchanged benchmark printed its existing p95 sample in addition to
p50 and p99; no benchmark or product source change was committed.

| Inline 128-byte RTT | Baseline |   IPC v2 | Absolute change |
| ------------------- | -------: | -------: | --------------: |
| p50                 | 0.024 ms | 0.030 ms |       +0.006 ms |
| p95                 | 0.044 ms | 0.054 ms |       +0.010 ms |
| p99                 | 0.058 ms | 0.066 ms |       +0.008 ms |

Both builds used a 64-byte shared-payload MessagePack body, two cold arena
offers, and zero warm arena offers. IPC v2 p99 remains well below the Windows
release limit of 1 ms. These are single-run local diagnostic samples rather
than a statistically controlled hardware benchmark; absolute deltas are more
meaningful here than percentages at tens-of-microseconds scale.

The refactor adds no IPC, allocation, filesystem access, or blocking lock to an
audio callback. The full check's real-time integration test confirms that warm
mixer rendering, preview consumption, and recording capture remain
allocation-free.

## Review focus

Reviewers should verify that new stateful routes cannot bypass
`registerRpcHandler`/`invokeRpc`, that every mutation identifies one commit
point and terminal outcome, and that any new worker/helper failure maps to a
typed `RpcError` exactly once. Architecture tests reject direct Electron IPC,
targetless startup snapshots, free-form operation errors, and project-worker
message/stack envelopes.
