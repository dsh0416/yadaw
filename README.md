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

Windows builds always include cpal's ASIO backend. ASIO is part of the standard
Windows product rather than an optional build variant; WASAPI remains available
alongside it. Building on Windows therefore requires LLVM/Clang for bindgen.
`asio-sys` downloads the Steinberg ASIO SDK automatically unless
`CPAL_ASIO_DIR` points to a local SDK. Running the ASIO backend additionally
requires a 64-bit ASIO driver supplied by the audio-interface vendor or a
development fallback such as ASIO4ALL.

The desktop build uses three repository-owned Vite configurations (main,
preload, and renderer). `electron-builder` only packages their outputs and the
native addon; no Electron-specific Vite framework owns the build pipeline.

## Prerequisites

```powershell
mise install
```

On Windows, install Visual Studio's **Desktop development with C++** workload
and LLVM/Clang, then expose libclang to the build:

```powershell
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
```

To use an already-downloaded ASIO SDK instead of the automatic download, also
set `CPAL_ASIO_DIR` to its extracted root.

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

## License

YADAW is licensed under the
[GNU General Public License v3.0](LICENSE).
