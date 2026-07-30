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
- [Product roadmap](roadmap.md)
- [Rust performance benchmarks](benchmarks.md)
- [Continuous integration and releases](ci.md)
- [Design system](design-system.md)
- [Design system audit](design-system-audit.md)
- [Development environment](environment.md)
- [Native call boundary](native-call-boundary.md)
- [Playback runtime architecture](playback-runtime.md)
- [Project database development rules](project-database.md)
