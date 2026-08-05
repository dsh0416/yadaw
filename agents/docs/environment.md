# Development Environment

This document describes the runtime and command-execution conventions for the
Heron development environment.

## Runtime Management

This project uses `mise` to manage the development tools required by the
JavaScript and Rust workspaces:

- APM
- Node.js
- pnpm
- Rust, including Cargo
- CMake 3.31 for building the pinned VST3 SDK test fixtures

The requested versions and version policies are defined in the repository-root
`mise.toml`. `mise.lock` resolves those policies to concrete tool versions and
download artifacts so development and automation remain reproducible across
machines.

Install the locked toolchain with:

```sh
mise install
```

JavaScript dependencies are locked separately by `pnpm-lock.yaml`. Install them
with:

```sh
mise run install
```

JavaScript, N-API, Electron, and documentation tasks depend on `install` when
they need workspace packages. Rust-only tasks such as `check-fast` and the
`rust:*` task family do not install pnpm dependencies.

Windows native builds always include cpal's ASIO backend. Windows development
hosts therefore require Visual Studio's Desktop development with C++ workload
and LLVM/Clang with `LIBCLANG_PATH` set to the directory containing
`libclang.dll`. `asio-sys` downloads the Steinberg ASIO SDK automatically;
set `CPAL_ASIO_DIR` only when using a preinstalled SDK. Runtime ASIO validation
also requires a 64-bit vendor ASIO driver or a fallback such as ASIO4ALL.
The production VST3 probe and host are Rust binaries. CMake and the C++ workload
are only required when building Steinberg SDK fixtures such as AGain and
NoteExpressionSynth from the recursive `third_party/vst3sdk` submodule.

## Running Commands

In normal local development, if the shell has already activated `mise`, run the
repository tasks directly:

```sh
mise run dev
mise run check
mise run check-fast
mise run build
mise run format
mise run format-check
mise run lint
mise run test
mise run coverage
```

Other repository tasks include:

```sh
mise run pack
mise run native
mise run bench:quick
mise run version:check
```

AI agents, automation, IDE subprocesses, and other non-interactive shells may
not inherit an activated `mise` environment. In those contexts, use
`mise exec --` to explicitly inject the repository-managed toolchain:

```sh
mise exec -- rustc --version
mise exec -- cargo --version
mise exec -- node --version
mise exec -- pnpm --version
mise exec -- apm --version
mise exec -- mise run check
```

When running a project command from a non-login shell, prefer:

```sh
mise exec -- <command>
```

This prevents a system-global Node.js, pnpm, Rust, Cargo, or APM installation
from silently replacing the versions declared by the repository.

Use pnpm workspace filters for package-level commands:

```sh
mise exec -- pnpm --filter @heron/desktop test:unit
mise exec -- pnpm --filter @heron/project-db test:integration
mise exec -- pnpm --filter @heron/dsp-node build
mise exec -- pnpm format:check
mise exec -- pnpm lint
mise exec -- cargo xtask test
```

pnpm scripts are JavaScript ecosystem leaf tasks. Use `cargo xtask` for direct
Rust workspace work and root mise tasks whenever JavaScript, Rust, N-API, or
packaging steps must be composed.

Prefer the root `mise run check` task before handing off a completed change
because it is the repository's full validation path.

`mise run check-fast` is the edit-loop path: Rust formatting, workspace lib/bin
Clippy, and library tests. It deliberately skips NAPI builds, integration tests,
examples, and benchmark compilation; `mise run check` remains the merge gate.

The Rust xtask discovers `rustc -vV`'s host triple and builds into
`target/<host-triple>/<profile>`. The `native:*` mise tasks combine the
package-local `@heron/dsp-node` napi-rs build with xtask's VST3 probe and
bundled plug-in build. xtask stages `heron-vst3-probe` into `target/debug` or
`target/release` and plug-in bundles into `target/bundles` for stable runtime
and packaging paths.

VST3 SDK bindings are generated into Cargo's `OUT_DIR` by
`heron-vst3-host-sys/build.rs` and are not checked into Git. A clean build
therefore requires the pinned LLVM/Clang toolchain, including on non-Windows
hosts. Cargo reruns Bindgen when the wrapper or its VST3/ARA header inputs
change.

`mise run check`, `mise run lint`, and the platform-native CI task build debug
N-API bindings before type-aware Oxlint, residual Vue ESLint, package
TypeScript checks, and tests that resolve `@heron/dsp-node`, so the gitignored
loaders and typings exist in CI and clean checkouts.

Oxfmt formats the tracked TypeScript, JavaScript, Vue, JSON, YAML, Markdown,
and CSS sources. Oxlint performs the primary type-aware TypeScript and Vue
script checks, while residual ESLint covers Vue templates and typed Vue
scripts. `eslint-plugin-oxlint` disables native rule overlap without disabling
the typed rules that Oxlint cannot yet execute inside Vue SFCs. Keep `oxlint`
and `eslint-plugin-oxlint` on matching versions when updating this toolchain.

rustfmt and Clippy cover every Rust workspace crate. Generated napi-rs loaders
and typings (gitignored under the native addon crates), Drizzle migration
metadata, lockfiles, build output, and third-party sources are excluded from
the JavaScript formatting and linting paths.

## Dependency Versions

As a general rule, use stable dependency and runtime releases. Avoid
prerelease, nightly, canary, or unpublished versions unless a specific task
requires one and the tradeoff has been discussed.

`mise.toml` may express a release line, such as Node.js 26 or Rust 1.97, while
`mise.lock` records the concrete resolved patch release. Do not hand-edit
`mise.lock`. After changing a tool declaration in `mise.toml`, or when
intentionally refreshing a resolved runtime, run:

```sh
mise lock
mise install
```

Commit the resulting `mise.lock` update together with the `mise.toml` change so
the runtime policy and its resolution stay synchronized.

Product version is lockstep across the monorepo. The repository-root `VERSION`
file is the single source of truth; `mise run version:sync` copies it into root
`Cargo.toml` (`[workspace.package].version`) and every versioned workspace
`package.json`, then rebuilds the N-API bindings. That rebuild regenerates the
gitignored JavaScript loaders and typings
(`crates/*/index.js`, `crates/*/index.d.ts`) from each package manifest, so
those files are never committed. `mise run version:check` (part of
`mise run check`) fails if any mirrored manifest version drifts. Do not edit
those mirrored version fields by hand.

JavaScript dependency versions belong in the applicable `package.json`, with
resolved dependency changes committed in `pnpm-lock.yaml`. Use the
repository-managed pnpm rather than another package manager.
