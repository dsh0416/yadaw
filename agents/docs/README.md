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
