# Agent Guide

This file is the entry point for AI agents and automation working in this
repository. Keep durable project documentation in `docs/`; keep agent-facing
development conventions here and under `agents/docs/`, and reusable agent
skills under `.agents/skills/`.

## Project Shape

- Product: experimental cross-platform desktop digital audio workstation
  (DAW).
- Desktop application: Electron with separate main, preload, and Vue renderer
  bundles built by repository-owned Vite configurations.
- Frontend: Vue 3, TypeScript, Pinia, Vue Router, Reka UI, Vitest, and
  Playwright.
- Native audio: Rust workspace with `dsp-core` for runtime-agnostic DSP and
  `dsp-node` for the napi-rs/cpal adapter loaded by Electron's main process.
- Windows native builds must always include cpal's ASIO backend. Do not
  introduce an ASIO-free Windows build variant; Windows build hosts must provide
  LLVM/Clang, and runtime validation requires a 64-bit ASIO driver.
- Shared packages: serializable IPC contracts, renderer-side audio-engine
  state, and a PGlite/Drizzle project database.
- Process boundary: the renderer uses the narrow typed preload API exposed as
  `window.yadaw`; it must never import the native `.node` addon directly.
- Real-time boundary: keep Electron IPC, UI work, filesystem access, allocation,
  and blocking synchronization out of audio callbacks.
- Runtime management: `mise` with locked Node.js, pnpm, Rust, and APM versions
  in `mise.toml` and `mise.lock`; pnpm manages the JavaScript monorepo.

## Common Commands

Use the project-managed toolchain:

```sh
mise install
mise run dev
mise run check
mise run build
mise run format
```

`mise run check` is the full validation path: Rust formatting, Clippy, tests,
real-time allocation invariants, benchmark compilation, napi-rs builds,
TypeScript checks, Vue unit tests, and project-database integration tests.
`mise run format` currently formats only the Rust workspace.

When running from a non-login shell, use `mise exec --` so commands resolve the
repository-managed Node.js, pnpm, Rust, and APM versions:

```sh
mise exec -- mise run check
mise exec -- cargo --version
mise exec -- pnpm --version
```

Use package-level scripts for narrower validation when appropriate:

```sh
mise exec -- pnpm --filter @yadaw/desktop test:unit
mise exec -- pnpm --filter @yadaw/project-db test:integration
mise exec -- pnpm test:e2e
mise exec -- pnpm check:rust
```

## Supporting Notes

- [Repository overview](README.md)
- [Architecture and real-time constraints](docs/architecture.md)
- [Rust performance benchmarks](docs/benchmarks.md)
- [Development environment](agents/docs/environment.md)
- [Renderer/native-call boundary](agents/docs/native-call-boundary.md)
- [Agent development notes](agents/docs/README.md)
- [Agent skill dependencies](apm.yml)

## Documentation Boundary

The `docs/` directory contains durable architecture, performance, deployment,
and usage documentation for contributors and users. Keep repository-wide agent
instructions in `AGENTS.md`, and place internal development-environment notes,
agent workflows, permission guidance, and implementation checklists under
`agents/docs/`. Treat `.agents/skills/` as APM-managed content derived from
`apm.yml` and `apm.lock.yaml`; update the dependency declarations instead of
hand-editing installed skill copies. Do not place temporary agent notes,
generated output, or benchmark artifacts in `docs/`.
