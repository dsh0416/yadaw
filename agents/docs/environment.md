# Development Environment

This document describes the runtime and command-execution conventions for the
YADAW development environment.

## Runtime Management

This project uses `mise` to manage the development tools required by the
JavaScript and Rust workspaces:

- APM
- Node.js
- pnpm
- Rust, including Cargo

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

The `dev`, `check`, `build`, `pack`, and `native` tasks depend on the `install`
task, so they install locked pnpm dependencies when necessary.

Windows native builds always include cpal's ASIO backend. Windows development
hosts therefore require Visual Studio's Desktop development with C++ workload
and LLVM/Clang with `LIBCLANG_PATH` set to the directory containing
`libclang.dll`. `asio-sys` downloads the Steinberg ASIO SDK automatically;
set `CPAL_ASIO_DIR` only when using a preinstalled SDK. Runtime ASIO validation
also requires a 64-bit vendor ASIO driver or a fallback such as ASIO4ALL.

## Running Commands

In normal local development, if the shell has already activated `mise`, run the
repository tasks directly:

```sh
mise run dev
mise run check
mise run build
mise run format
```

Other repository tasks include:

```sh
mise run pack
mise run native
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
mise exec -- pnpm --filter @yadaw/desktop test:unit
mise exec -- pnpm --filter @yadaw/project-db test:integration
mise exec -- pnpm --filter @yadaw/dsp-node build
```

Prefer the root `mise run check` task before handing off a completed change
because it is the repository's full validation path.

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

JavaScript package versions belong in the applicable `package.json`, with
resolved dependency changes committed in `pnpm-lock.yaml`. Use the
repository-managed pnpm rather than another package manager.
