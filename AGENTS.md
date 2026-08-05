# Agent Guide

This file is the entry point for AI agents and automation working in this
repository. Keep project and agent-facing documentation under `agents/docs/`,
the VitePress website and user manual under `docs/`, and reusable agent skills
under `.agents/skills/`.

## Project Shape

- Product: experimental cross-platform desktop digital audio workstation
  (DAW).
- Desktop application: Electron with separate main, preload, and Vue renderer
  bundles built by repository-owned Vite configurations.
- Frontend: Vue 3, TypeScript, Pinia, Vue Router, Reka UI, Vitest, and
  Playwright.
- Native audio: Rust workspace with `dsp-core` for runtime-agnostic DSP and
  `dsp-node` for the napi-rs addon loaded directly by Electron's main process.
  The addon owns the embedded audio runtime, cpal device streams, plug-in host,
  telemetry, and bounded control queues. There is no audio helper process.
- Windows native builds must always include cpal's ASIO backend. Do not
  introduce an ASIO-free Windows build variant; Windows build hosts must provide
  LLVM/Clang, and runtime validation requires a 64-bit ASIO driver.
- Shared packages: serializable IPC contracts, reusable Vue UI primitives, and
  a PGlite/Drizzle project database.
- Process boundary: the renderer uses the narrow typed preload API exposed as
  `window.heron`; it must never import the native `.node` addon directly.
- Renderer/main cross-process calls use explicit resource handles and serializable
  success/error unions. Stateful mutations require one commit point,
  prepare/abort cleanup, idempotency or operation-status reconciliation, and a
  documented recoverable or quarantined failure state. Do not use exceptions,
  rejected Promises, Rust panics, ambient "current" resources, or free-form
  error strings as cross-process protocol semantics.
- Real-time boundary: keep Electron IPC, UI work, filesystem access, allocation,
  and blocking synchronization out of audio callbacks.
- Native boundary: Electron main may call `@heron/dsp-node`; preload and renderer
  must not import it. The local MessagePack request envelope is a N-API ABI, not
  an inter-process transport. Do not add process supervision, OS shared memory,
  or helper restart/reconciliation around the embedded runtime.
- Runtime management: `mise` with locked Node.js, pnpm, Rust, and APM versions
  in `mise.toml` and `mise.lock`; pnpm manages the JavaScript monorepo.
- Prefer TypeScript for hand-authored Node.js scripts and tool configuration.
  Run erasable TypeScript directly with the locked Node.js 26 runtime and check
  it with a dedicated `tsconfig` using `erasableSyntaxOnly`. Reserve `.mjs` and
  `.cjs` for generated files or bundle outputs whose consumers require those
  extensions.
- Treat 800 lines in a hand-authored production source file as a review trigger,
  not a hard limit. Keep binary entry points, package barrels, route views, and
  application composition roots thin; split growing modules by feature and
  ownership boundary rather than by arbitrary type categories.

## Common Commands

Use the project-managed toolchain:

```sh
mise install
mise run dev
mise run docs
mise run check
mise run check-fast
mise run build
mise run docs-build
mise run format
mise run format-check
mise run lint
```

`mise run check` is the full validation path: Oxfmt, Oxlint, residual Vue
ESLint, Rust formatting, Clippy, tests, real-time allocation invariants,
benchmark compilation, napi-rs builds, TypeScript checks, Vue unit tests, and
project-database integration tests. `mise run format` applies Oxfmt and
rustfmt; `mise run format-check` and `mise run lint` provide the corresponding
non-mutating checks.

When running from a non-login shell, use `mise exec --` so commands resolve the
repository-managed Node.js, pnpm, Rust, and APM versions:

```sh
mise exec -- mise run check
mise exec -- cargo --version
mise exec -- pnpm --version
```

Use package-level scripts for narrower validation when appropriate:

```sh
mise exec -- pnpm --filter @heron/desktop test:unit
mise exec -- pnpm --filter @heron/project-db test:integration
mise exec -- mise run test:e2e
mise exec -- cargo xtask test
mise exec -- pnpm format:check
mise exec -- pnpm lint
```

## Supporting Notes

- [Repository overview](README.md)
- [User manual](docs/content/manual/index.md)
- [Architecture and real-time constraints](agents/docs/architecture.md)
- [Product roadmap](agents/docs/roadmap.md)
- [Rust performance benchmarks](agents/docs/benchmarks.md)
- [Development environment](agents/docs/environment.md)
- [Renderer/native-call boundary](agents/docs/native-call-boundary.md)
- [Cross-process resource and error contract](agents/docs/cross-process-error-contract.md)
- [Project database development rules](agents/docs/project-database.md)
- [Agent development notes](agents/docs/README.md)
- [Agent skill dependencies](apm.yml)

## Documentation Boundary

Keep repository-wide agent instructions in `AGENTS.md`. The `docs/` workspace
is the public VitePress website: keep its content focused on the product landing
page and end-user manual. Place architecture, roadmap, performance, CI,
design-system, development-environment notes, agent workflows, permission
guidance, and implementation checklists under `agents/docs/`. Treat
`.agents/skills/` as APM-managed content derived from `apm.yml` and
`apm.lock.yaml`; update the dependency declarations instead of hand-editing
installed skill copies. Do not place temporary agent notes, generated output,
or benchmark artifacts in either documentation directory.
