# ADR-0003: Make explicit device selection win reconnect races

- Status: Proposed
- Date: 2026-08-08
- Owners: project maintainers
- Related: `agents/docs/product-live.md`

## Context

Losing the active output blocks a Live session. Heron should offer another
device immediately while continuing to recover a transiently disconnected
interface. These operations can complete out of order. Publishing the last
completion would let a stale background attempt undo the user's explicit
choice.

## Decision

Device recovery uses monotonically ordered generations and a single commit
point. Device loss opens the recovery decision immediately and starts bounded
reconnect attempts for the old configuration. Committing a user-selected device
creates the authoritative generation. Results from older attempts are stale and
cannot publish or overwrite it.

If the old device reconnects before a user selection commits, it may resume
audio. The dialog remains a valid decision surface, and a later explicit choice
still switches to the selected device.

## Alternatives rejected

### Cancel reconnect while the dialog is open

This makes a transient cable or driver reset cause avoidable silence while the
user reads the dialog.

### Last completion wins

Completion order is nondeterministic and can overwrite an explicit choice with
an older automatic attempt.

### Always prefer the original device

This makes it impossible for the user to move the performance to a working
replacement while the old device flaps.

## Consequences

- Attempts carry generation and intended configuration through the typed native
  boundary.
- Stale success is observable for diagnostics but has no state mutation.
- The UI can refresh the candidate list without replacing focus or committing a
  choice.
- Reconfiguration tests must control completion order.

## Verification

State-machine tests cover loss, old-device recovery, user choice before and
after recovery, stale failure, stale success, rapid repeated choices, and app
shutdown. E2E verifies the dialog and final published device.

## Reconsider when

Reconsider if the device API gains a transactional handoff primitive with
stronger guarantees than generation-based publication.
