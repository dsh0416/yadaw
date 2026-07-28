# Continuous integration and releases

The `Test`, `Build`, and `Publish` GitHub Actions workflows are the source of
truth for validation, packaging smoke builds, and tagged releases.

## Workflows

- **Test** (`.github/workflows/test.yml`) runs repository checks and
  cross-platform tests. The `quality` job matrices Linux x64, Windows x64,
  and macOS arm64 so Clippy (and rustfmt on non-Linux runners) covers
  OS/arch-specific lint differences; Linux also runs the full `pnpm check`.
  Required status checks for pull requests should include jobs from this
  workflow.
- **Build** (`.github/workflows/build.yml`) packages installers for all five
  supported platforms as a packaging smoke test. It runs on pull requests,
  `main`, version tags, and manual dispatch. Required status checks for pull
  requests should also include jobs from this workflow.
- **Publish** (`.github/workflows/publish.yml`) starts via `workflow_run` after
  `Test` or `Build` completes. It publishes a GitHub Release only when both
  workflows have succeeded for the same commit on a `v*` tag push. Pull
  requests and `main` builds never publish.

## Workflow tiers

- Pull requests run `Test` (multi-OS `quality` including Clippy, plus
  Windows/macOS tests) and `Build` (installer packaging smoke across Windows
  x64, Linux x64 and arm64, and macOS x64 and arm64). Installers remain
  available as workflow artifacts for 14 days.
- Pushes to `main` and manual `workflow_dispatch` runs use the same `Test` and
  `Build` gates.
- Tags beginning with `v` run `Test` and `Build`. After both succeed, `Publish`
  downloads the Build artifacts and publishes the five installers, a
  `SHA256SUMS` file, generated release notes, and (for public repositories)
  GitHub artifact attestations to a GitHub Release.

All three workflows install the versions in `mise.lock`, use frozen pnpm
dependencies, and pin the VST3 SDK commit where a native setup is required.
The mise installation, pnpm store, Cargo downloads, and Electron downloads
have separate platform-and-architecture cache keys. Rust compilation uses
sccache's GitHub Actions backend. The Cargo `target` directory is deliberately
not cached because it is large and can retain stale platform-specific build
state.

`Publish` checks out `workflow_run.head_sha` and downloads artifacts from the
matching successful `Build` run, because under `workflow_run` the default
`github.ref` is not the triggering tag.

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
versions become the latest release. Rerunning successful tagged `Test` and
`Build` workflows allows `Publish` to replace the assets on an existing
release.

Installers are currently unsigned. Code-signing identities and notarization
credentials should be configured before treating the packages as a general
public distribution.
