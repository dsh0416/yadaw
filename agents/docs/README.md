# Agent Development Notes

This directory holds project and agent-facing documentation that is too detailed
for the repository-level `AGENTS.md`.

Use it for architecture, roadmap, performance, CI, design-system notes,
development-environment guidance, agent workflows, permission guidance,
implementation checklists, and other automation-specific conventions. Manage
reusable agent skills through `apm.yml` rather than documenting or editing
installed copies under `.agents/skills/`.

## Notes

- [Architecture and real-time constraints](architecture.md)
- [Architecture decision records](adr/README.md)
- [Product roadmap](roadmap.md)
- [Live performance product contract](product-live.md)
- [Engineering standards](engineering-standards.md)
- [Product interaction design](interaction-design.md)
- [Rust performance benchmarks](benchmarks.md)
- [Continuous integration and releases](ci.md)
- [Design system](design-system.md)
- [Design system audit](design-system-audit.md)
- [Development environment](environment.md)
- [Native call boundary](native-call-boundary.md)
- [Renderer/main resource and error contract](cross-process-error-contract.md)
- [Playback runtime architecture](playback-runtime.md)
- [Project database development rules](project-database.md)

## Authority

`AGENTS.md` is the concise repository entry point. These documents are the
normative detail behind it. The roadmap orders user outcomes; the Live product
contract defines Current acceptance; engineering standards govern code and
tests; architecture and ADRs govern ownership and durable technical decisions;
interaction design governs workflow behavior; and the design system governs
visual primitives and accessibility.

The public `docs/` workspace describes behavior that is already available to
users. Do not use public documentation to announce unimplemented roadmap scope.

## Adoption and precedence

These rules are adopted for all new work and all materially changed code or
behavior from 2026-08-08 onward. Existing code is not evidence that a conflicting
pattern is still permitted. When a change touches non-conforming code, either
bring the affected scope into compliance or link a narrowly scoped tracking
issue or policy exception.

Apply the documents by responsibility:

1. [Engineering standards](engineering-standards.md) govern implementation,
   testing, review evidence, errors, module cohesion, and exceptions.
2. [Architecture](architecture.md) governs current ownership, dependency
   direction, process/thread boundaries, protocols, and real-time assumptions.
3. [Interaction design](interaction-design.md) governs product workflow,
   control exposure, feedback, recovery, and Logic-compatible behavior.
4. [Accepted ADRs](adr/README.md) preserve durable decisions and explain why
   the current architecture or interaction rule exists.

The roadmap decides sequencing but does not waive these rules. A proposed ADR
is not authority. When an accepted ADR changes a durable decision, update the
current architecture or interaction document in the same change. If an
accepted ADR and a current-state document disagree, stop and reconcile the
documentation before treating either interpretation as permission to ship.

Mechanical rules belong in `mise run check` or a narrower repository check.
Judgment-based rules are recorded in the pull-request governance review.
Exceptions and deferred correctness work require a linked issue; no separate
waiver process is required at the current project scale.
