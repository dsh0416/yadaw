# YADAW

YADAW is an experimental desktop digital audio workstation built with Vue,
Reka UI primitives, and a Rust DSP core.

## Architecture

- `apps/desktop`: Electron host, secure preload bridge, and Vue renderer.
- `packages/contracts`: shared, serializable IPC contracts.
- `packages/audio-engine`: renderer-side state model for the native audio engine.
- `crates/dsp-core`: runtime-agnostic Rust DSP code.
- `crates/dsp-node`: napi-rs adapter loaded only by Electron's main process.

The renderer never imports the native addon. Non-real-time commands cross the
preload bridge. Audio backends and devices come exclusively from cpal through
the napi-rs addon; Chromium `MediaDevices` is not part of the device model.

Audio preferences are modeled in `@yadaw/contracts` and persisted by the Vue
renderer. Device IDs and buffer capabilities come from cpal. Applying the
preferences opens native input/output streams and a preallocated SPSC bridge in
Rust; the UI only polls an atomic runtime and latency snapshot.

ASIO support is opt-in because cpal's ASIO backend needs the ASIO SDK and
LLVM/Clang. On a configured Windows build host, use
`pnpm --filter @yadaw/dsp-node build:asio`; unavailable backends are disabled in
the preferences UI.

The desktop build uses three repository-owned Vite configurations (main,
preload, and renderer). `electron-builder` only packages their outputs and the
native addon; no Electron-specific Vite framework owns the build pipeline.

## Prerequisites

```powershell
mise install
```

## Development

```powershell
mise run dev
```

The development task installs locked pnpm dependencies when needed, builds the
native addon in debug mode, and then starts Electron with the repository-owned
Vite watchers. Use `mise run check` for Rust tests, Clippy, formatting, napi-rs,
and TypeScript checks, or `mise run build` for a production build. The underlying
pnpm scripts remain available for package-level development.

See [docs/architecture.md](docs/architecture.md) for the process boundaries and
the next implementation milestones.
