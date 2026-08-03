# Cross-Process Resource and Error Contract

This document is normative for every call that crosses a Heron process or
thread-isolation boundary:

- renderer to Electron main through preload;
- Electron main to a project worker;
- Electron main to `audio-host-client`;
- `audio-host-client` to `audio-host`;
- process-owned actors or workers when failure can outlive one request.

The goal is not merely to report errors. A failed request must leave every
affected resource in a state that the authoritative owner can identify,
reconcile, and either retry or replace. Cross-process exceptions, panics, and
partially visible mutations are prohibited protocol semantics.

## Implementation status

IPC protocol version 2 is implemented across renderer/preload, Electron main,
project workers, the native addon, and the audio helper. Renderer/main/worker
requests retain their explicit protocol version. Native addon and helper are a
same-build pair by construction, so native bootstrap contains no compatibility
adapter or build fingerprint; shared-memory layouts continue to validate their
own magic and layout versions.

- `bootstrap()` is the only targetless state request.
- Every `HeronDesktopApi` request resolves to `RpcResult<T>`; Electron
  transport rejection is converted at preload rather than exposed as application
  control flow.
- Stateful routes validate an explicit `ResourceRef`, parent generation, and
  revision before mutation.
- Main owns `ResourceRegistry`, `OperationRegistry`, and the desired-state
  projection. Pinia subscribes before bootstrap and reboots its projection on
  sequence gaps or epoch changes.
- Project-worker and native-helper failures cross the wire as typed `RpcError`
  values. Error messages, stacks, JavaScript exceptions, Rust panics, and
  `ControlResult::Error { message }` are not protocol variants.
- Project archives and recording recovery use durable journals. Runtime graph,
  transport, parameter, and telemetry state remains scoped to the owning epoch.

Project create/open uses a fresh candidate worker and graph generation. Main
does not expose the candidate through the resource registry, lifecycle state,
or Pinia until database open, graph/materialization, native staging, activation,
and the main commit have succeeded. Failure terminates or quarantines only the
candidate, so the next healthy open uses a new generation.

Project close prepares and activates a silent graph before dropping the project
resource subtree. A dirty project requires an explicit `save`, `discard`, or
`cancel` disposition; the renderer presents that choice before issuing the
mutation. Cleanup failure cannot restore a half-closed project as active.

The implementation and verification record is maintained in
[IPC v2 delivery verification](ipc-v2-delivery.md). New routes must preserve
these invariants; there is no accepted legacy route shape.

## Authoritative state

There is one authoritative owner for each fact, not one process that pretends
to own every fact:

| Fact                                                          | Authoritative owner                   |
| ------------------------------------------------------------- | ------------------------------------- |
| Project session lifecycle and desired application state       | Electron main                         |
| Persisted project contents                                    | The active project database worker    |
| Audio device, stream, active graph, and plug-in runtime state | `audio-host`                          |
| Renderer-visible application state                            | A revisioned projection of main state |
| Purely visual and ephemeral UI state                          | Pinia                                 |

Electron main owns the resource registry and coordinates transitions between
these owners. It stores desired native state and reconciles it with observed
native snapshots. Pinia is never the authority for a project, recording, audio
engine, graph, or plug-in lifecycle.

## Result algebra

Every cross-process request returns a serializable result value. Rejecting a
Promise, throwing an exception across Electron IPC, returning an error string,
or panicking in Rust is not the application protocol.

The shared contract has this conceptual shape:

```ts
type RpcResult<T> =
  | {
      ok: true
      requestId: string
      operationId?: string
      resourceRevision?: number
      value: T
      warnings: RpcWarning[]
    }
  | {
      ok: false
      requestId: string
      operationId?: string
      error: RpcError
    }

interface RpcError {
  code: RpcErrorCode
  category:
    | "validation"
    | "conflict"
    | "stale-resource"
    | "busy"
    | "cancelled"
    | "unavailable"
    | "timeout-unknown"
    | "dependency-failed"
    | "invariant-violation"
  outcome: "not-committed" | "unknown" | "quarantined"
  retry: "never" | "safe" | "after-reconcile"
  correlationId: string
  userMessageKey: string
  resource?: ResourceRef
  details?: RpcErrorDetails
}
```

Rust code uses `Result<T, E>` internally and maps its typed error exactly once
at the wire boundary. Wire errors are enums or discriminated unions with stable
codes; `anyhow::Error`, `Box<dyn Error>`, JavaScript `Error`, backtraces, and
free-form strings do not cross the wire. An internal source chain may be logged
once with the same correlation ID, but it is not the protocol.

Callers must exhaustively match success and error variants. A convenience
helper may transform an `RpcResult`, but preload and native bindings must not
silently convert it back into exception-driven control flow.

Transport loss before a response is itself converted by the nearest live
boundary into `unavailable` or `timeout-unknown`. It is not evidence that the
operation failed.

## Explicit resources

Every stateful operation names its target with an opaque resource reference:

```ts
interface ResourceRef {
  kind: string
  id: string
  epoch: string
  generation: number
}
```

- `id` identifies the logical resource.
- `epoch` identifies the owning process or worker incarnation. It is encoded as
  a decimal string so a Rust `u64` never loses precision in JavaScript.
- `generation` identifies the resource incarnation within that process.
- Mutations also carry `expectedRevision` when concurrent updates are possible.

The owner validates the complete reference before doing work. Restarting a
worker or helper increments its epoch and invalidates all older references.
Missing, mismatched, or stale references produce `stale-resource` without
mutation.

Commands must not implicitly address "the current project", `lastGraph`, the
most recently created plug-in, or another ambient resource. Private
implementation caches are permitted only when lookup begins with an explicit
validated reference.

Resource dependencies are strict. A graph belongs to one project session, a
plug-in instance belongs to one graph generation, and an engine belongs to one
helper epoch. Dropping or replacing a parent invalidates every child before a
new child can reuse its logical ID.

## Atomic transition rule

Each mutating operation has one documented commit point owned by one process.
Before that point, work is staged and invisible. After that point, the owner can
answer whether the operation committed even if the response was lost.

An operation may finish in only one of these states:

1. **Committed**: the new revision is authoritative and returned or discoverable
   by `operationId`.
2. **Not committed**: the previous committed state remains authoritative and
   every staged resource is released.
3. **Quarantined**: local rollback was impossible, so the affected resource
   epoch is invalidated and replaced or moved to an explicit safe terminal
   state. Unrelated resources remain usable.

There is no fourth "partly updated and assumed failed" state.

Cross-process workflows use `prepare -> commit -> abort`:

1. Create candidate resources under a new generation.
2. Validate inputs and dependencies.
3. Perform fallible I/O and compilation without publishing the candidate.
4. Commit with one owner-local atomic swap or durable rename.
5. Publish the new revision.
6. Abort and release the candidate on every pre-commit error.

Operations spanning multiple authoritative owners are coordinated sagas, not
fictional in-memory distributed transactions. Main records the operation and
its compensation steps. A downstream commit is not followed by another
fallible step unless that step can be retried idempotently or compensated.

Non-critical work such as waveform generation, recent-project bookkeeping, or
optional plug-in restoration happens after commit as an observable background
operation. Its failure may produce a degraded resource; it must not retroactively
turn a committed project open into an ambiguous failure.

## Idempotency and unknown outcomes

Every mutation has an `operationId`. Retriable mutations also have an
idempotency key scoped to the target resource generation.

- An owner stores the terminal outcome until the caller has observed it or the
  resource epoch is retired.
- Repeating an idempotency key returns the original terminal result.
- A timeout after dispatch produces `timeout-unknown`.
- The caller queries operation status or reconciles a resource snapshot; it
  never blindly repeats a non-idempotent command.
- Cancellation is a request. The terminal result states whether cancellation
  won the race with commit.

Reads may be latest-wins. Mutations are FIFO, exclusive, or revision-checked;
they are never latest-wins.

## Recovery policy

| Error category        | Required state and recovery                                       |
| --------------------- | ----------------------------------------------------------------- |
| `validation`          | No mutation; caller fixes the request.                            |
| `conflict`            | No mutation; caller refreshes the resource revision.              |
| `stale-resource`      | No mutation; caller discards the handle and reconciles.           |
| `busy`                | No mutation; retry only when the resource reports readiness.      |
| `cancelled`           | Previous state or a documented committed result is authoritative. |
| `unavailable`         | Owner epoch is unhealthy; supervisor replaces or reconnects it.   |
| `timeout-unknown`     | Query operation status before any retry.                          |
| `dependency-failed`   | Candidate is aborted; parent remains committed or degraded.       |
| `invariant-violation` | Quarantine the smallest affected epoch and rebuild it.            |

A worker or helper crash invalidates that process epoch. Recovery reconstructs
resources from committed authoritative state, never from the most recent
attempted request or an uncommitted cache.

Cleanup is idempotent. A failed cleanup quarantines the candidate and schedules
reaping; it must not prevent creation of an unrelated replacement resource.

## Renderer projection

Main publishes snapshots and events containing process epoch, monotonic event
sequence, resource revision, and operation ID. Pinia:

- subscribes before fetching the initial snapshot;
- ignores events older than the accepted sequence;
- detects a sequence gap and fetches a fresh snapshot;
- stores UI request progress separately from authoritative lifecycle state;
- never manufactures a successful lifecycle transition from an IPC return
  value that lacks the corresponding committed revision.

Optimistic UI is allowed only as a visibly pending intent. It is not an
authoritative state mutation.

## Rust enforcement

Production code in Rust modules that define or transport the cross-process
protocol must deny:

```rust
#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::panic_in_result_fn,
        clippy::unwrap_used
    )
)]
```

The strict lint is enabled in `dsp-runtime::protocol`, `ipc-transport`,
`audio-host-client`, and `audio-host::runtime`. The workspace denies
`unused_must_use`. Boundary results therefore cannot be
dropped accidentally. Tests may use `expect`, `unwrap`, or `panic` to express a
failed assertion; production exceptions require a narrowly scoped `allow` with
a reason and an update to this document.

Clippy cannot prove transaction atomicity, resource dependency validity, or
recovery completeness. Those properties require:

- typed resource references and result envelopes;
- prepare/commit/abort APIs that make premature publication difficult;
- owner-local atomic swaps, temporary-file renames, or durable operation
  journals as appropriate;
- fault injection before and after every await, send, receive, file operation,
  worker exit, and native publication;
- tests proving that a healthy request succeeds immediately after each injected
  failure;
- stale-response, duplicate-operation, timeout-after-commit, cleanup-failure,
  and helper-restart tests.

For every mutating route, the test matrix must assert the committed resource
snapshot, native observed snapshot, lifecycle projection, and ability to
perform the next unrelated operation.

## Implemented project mutation and archive slice

Project graph commands now target the committed `ProjectGraphRef` with its
expected resource revision. The Project Worker validates and retains a
`prepare-project-command` token without changing PGlite. Main prepares the
native candidate first, then `commit-project-command` is the single project
data commit point. The worker returns a fresh DB snapshot after commit; Main
uses that snapshot, rather than the attempted in-memory graph, to advance the
resource revision and Pinia projection.

The worker retains committed command results by `operationId`. If the commit
response is lost, Main queries `project-command-status`; it never replays the
command blindly. The worker refuses new preparations after 2,048 unacknowledged
terminal results instead of evicting an outcome silently. A failed native
activation after DB commit is reported as a degraded warning: the DB mutation
remains committed, and the committed desired graph becomes the only helper
restart source.

Project save and save-as use a durable Node-side archive journal. The journal
records the temp dump, backup rename, and target rename. Recovery restores the
backup if interruption occurred before the commit rename, and preserves the
new target if the rename committed but its response or journal update was
lost. The renderer route returns `RpcResult` and retains its operation outcome
for status reconciliation.

## Review checklist

Before adding or changing a cross-process mutation:

1. Name the authoritative owner and explicit resource reference.
2. Define the request, success value, typed errors, and retry policy.
3. Identify the single commit point.
4. Define abort cleanup and quarantine behavior.
5. Define idempotency and timeout-unknown reconciliation.
6. List child resources invalidated with the parent.
7. Keep all pre-commit side effects invisible.
8. Keep non-critical work outside the commit transaction.
9. Add fault injection on every fallible boundary.
10. Demonstrate that the next healthy operation succeeds after every failure.
