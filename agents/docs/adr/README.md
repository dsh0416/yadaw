# Architecture decision records

ADRs record durable decisions and the alternatives that were deliberately not
chosen. They do not replace architecture documentation: the accepted result is
also reflected in the relevant current-state document.

## Required triggers

Create an ADR before a change that:

- changes a process, thread, real-time, or ownership boundary;
- changes project format, persistence ownership, or compatibility policy;
- adds or materially changes a cross-process/native protocol;
- changes a real-time safety assumption;
- introduces a foundational framework or dependency;
- creates a long-term compatibility commitment; or
- materially departs from the Logic interaction reference or an accepted
  architecture rule.

Small implementation choices, reversible refactors within one owner, and issue
triage do not need an ADR.

## Lifecycle

Use four digits and a short kebab-case title. Copy [the template](template.md),
then set one status:

- **Proposed** — under review; implementation must not assume acceptance.
- **Accepted** — authoritative and reflected in current documentation.
- **Superseded by ADR-NNNN** — retained as history, no longer authoritative.
- **Rejected** — considered and deliberately not adopted.

An accepted ADR is immutable except for typo fixes and links. Replace a changed
decision with a new ADR and mark the old one superseded. The decision records
why; issue and pull-request discussion records implementation progress.

## Review requirements

An ADR identifies the owner, context, decision, rejected alternatives,
consequences, verification, and conditions that would justify reconsideration.
Link the issue or pull request when one exists. At the current project scale,
ADR and policy exceptions need no separate approval bureaucracy beyond normal
review.

## Records

- [ADR-0001: Embed the native audio runtime](0001-embedded-audio-runtime.md)
- [ADR-0002: Address Live MIDI controls by ordered channels and plug-in aliases](0002-live-midi-control-addressing.md)
- [ADR-0003: Make explicit device selection win reconnect races](0003-device-recovery-precedence.md)
- [ADR-0004: Keep project media canonical and audition outside transport](0004-project-media-assets.md)
- [ADR-0005: Tier Linux plug-in editor compatibility](0005-tier-linux-plug-in-editor-compatibility.md)
