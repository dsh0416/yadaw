# Continuous integration and releases

The `CI`, `Test`, `Build`, and `Publish` GitHub Actions workflows are the
source of truth for validation, documentation deployment, packaging smoke
builds, and tagged releases.

## Workflows

- **CI** (`.github/workflows/ci.yml`) runs on pull requests and pushes to
  `main`. It calls the reusable Test and Build workflows and builds the
  VitePress user documentation in parallel, then reports their combined result
  through the stable `Gate` job. After the gate succeeds on `main`, it deploys
  the documentation artifact to GitHub Pages. Configure the `Gate` check (shown
  under the `CI` workflow) as the only required status check for pull requests.
- **Test** (`.github/workflows/test.yml`) runs repository checks on Linux x64,
  Windows x64, and macOS. Linux runs `pnpm check:coverage`, a variant of
  `pnpm check` that swaps every test invocation for its coverage-producing
  counterpart, so each test suite runs exactly once. The reports are uploaded
  to Codecov. It is reusable through `workflow_call` and can also be started
  manually. Callers must pass `CODECOV_TOKEN` when available (see `CI` and
  `Publish`).
- **Build** (`.github/workflows/build.yml`) packages installers for Windows
  x64, Linux x64 and arm64, and universal macOS as a packaging smoke test. It
  is reusable through `workflow_call` and can also be started manually. CI and
  manual smoke runs disable release LTO (`CARGO_PROFILE_RELEASE_LTO=false`,
  higher `codegen-units`, stripped symbols) so MSVC packaging stays tolerable;
  pass `full_release_profile: true` to keep the Cargo.toml thin-LTO settings.
- **Publish** (`.github/workflows/publish.yml`) runs on a `v*` tag, validates
  that the tag matches `VERSION`, calls the reusable Test and Build workflows
  (Build with `full_release_profile: true`), and creates a draft GitHub Release
  only after both succeed.

## Workflow tiers

- Pull requests and pushes to `main` run `CI`, which calls `Test` and `Build`
  and builds the user documentation. The `Gate` job succeeds only when all
  three jobs succeed. Main-branch runs then deploy the documentation to GitHub
  Pages. Installers remain available as workflow artifacts for 14 days.
- Manual `workflow_dispatch` runs are available on `CI`, `Test`, and `Build`.
- Tags beginning with `v` run `Publish`, which calls `Test` and `Build`. After
  both succeed, `Publish` downloads the Build artifacts and adds the
  installers, a `SHA256SUMS` file, generated release notes, and (for public
  repositories) GitHub artifact attestations to a draft GitHub Release.

The Test and Build workflows install the versions in `mise.lock`, use frozen
pnpm dependencies, and pin the VST3 SDK commit where a native setup is
required. The mise installation, pnpm store, Cargo downloads, and Electron
downloads have separate platform-and-architecture cache keys. Rust compilation
uses sccache's GitHub Actions backend. Check jobs may restore a Cargo `target`
cache; packaging jobs leave it disabled because the directory is large and can
retain stale platform-specific build state. On Linux, coverage is collected
in the Checks test pass itself: Vitest writes lcov as it runs and
`cargo llvm-cov` doubles as the Rust test run, writing instrumented artifacts
to `target-coverage/` so they stay out of the shared Checks `target` cache.
cargo-llvm-cov chains the sccache `RUSTC_WRAPPER` and instruments only
workspace crates, so sccache caches those builds and repeat runs reuse them.

## Coverage

On the Linux Checks leg, CI runs `pnpm check:coverage`: `pnpm check` with
`check:rust:coverage` in place of `check:rust` and `test:coverage:js` in place
of the plain Vitest runs, so every test suite executes exactly once with
coverage enabled. `cargo llvm-cov` doubles as the Rust test run; doc tests
do not run under it and remain exercised by the Windows and macOS legs. The
same `pnpm check:coverage` command reproduces the Linux leg locally.

For ad-hoc local coverage, use the dedicated scripts:

```sh
pnpm test:coverage:js
pnpm test:coverage:rust
# or both:
pnpm test:coverage
```

JavaScript coverage requires `@vitest/coverage-v8` (installed with the
workspace). Rust coverage requires the locked `cargo-llvm-cov` tool and the
`llvm-tools-preview` Rust component from `mise.toml`. Reports land under
`coverage/` (gitignored) and are uploaded to Codecov with the repository
`CODECOV_TOKEN` secret. The Rust coverage run writes instrumented objects to
`target-coverage/` so they stay out of the shared `target/` cache, and keeps
the sccache wrapper so repeat runs reuse cached builds.

`codecov.yml` tags uploads with `javascript` and `rust` flags, and defines
Codecov components for each coverage-producing workspace package or crate
(`desktop`, `contracts`, `project-db`, `project-model`, `ui`, the `dsp-*` /
host crates, and `plugins`). Components drive per-area project and patch
status checks and appear in the Codecov PR comment. After Vitest writes each
package report, `test:coverage:js` rewrites `SF:` paths to be repository
relative so Codecov can attribute monorepo package coverage correctly.

## Creating a release

`VERSION`, the root package, all workspace packages, and the Cargo workspace
version must match before `Test` and `Build` can pass. Prepare and publish a
release with:

```sh
pnpm sync:version
pnpm check:version
git tag "v$(cat VERSION)"
git push origin "v$(cat VERSION)"
```

The tag must equal `v` followed by the exact contents of `VERSION`. A
prerelease version such as `0.2.0-beta.1` creates a GitHub prerelease; other
versions become the latest release. Rerunning `Publish` replaces the assets on
an existing draft release.

Installers are currently unsigned. Code-signing identities and notarization
credentials should be configured before treating the packages as a general
public distribution.
