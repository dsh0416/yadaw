# Continuous integration and releases

The `Test` and `Build` GitHub Actions workflows are the source of truth for
validation, cross-platform packaging, and tagged releases.

## Workflows

- **Test** (`.github/workflows/test.yml`) runs repository checks and
  cross-platform tests. Required status checks for pull requests should target
  jobs from this workflow.
- **Build** (`.github/workflows/build.yml`) starts after a successful `Test` run
  via `workflow_run`. It packages installers and, for version tags, publishes a
  GitHub Release. Pull request `Test` runs never trigger packaging.

## Workflow tiers

- Pull requests run the complete repository check on Linux (including Clippy)
  and Clippy plus the Rust, renderer, and project-database test suites on
  Windows x64 and macOS arm64.
- Pushes to `main` run the same `Test` gates. After `Test` succeeds, `Build`
  creates installers for Windows x64, Linux x64 and arm64, and macOS x64 and
  arm64. The installers remain available as workflow artifacts for 14 days.
- Manual `Test` runs (`workflow_dispatch`) behave like `main`: a successful run
  triggers `Build` packaging and is useful for validating installers before a
  release.
- Tags beginning with `v` run every `Test` gate. After `Test` succeeds, `Build`
  publishes the five installers, a `SHA256SUMS` file, generated release notes,
  and (for public repositories) GitHub artifact attestations to a GitHub
  Release.

Both workflows install the versions in `mise.lock`, use frozen pnpm
dependencies, and pin the VST3 SDK commit. The mise installation, pnpm store,
Cargo downloads, and Electron downloads have separate
platform-and-architecture cache keys. Rust compilation uses sccache's GitHub
Actions backend. The Cargo `target` directory is deliberately not cached
because it is large and can retain stale platform-specific build state.

`Build` checks out the exact commit SHA validated by `Test`
(`workflow_run.head_sha`), because under `workflow_run` the default
`github.ref` is not the triggering branch or tag.

## Creating a release

`VERSION`, the root package, all workspace packages, and the Cargo workspace
version must match before `Test` can pass. Prepare and publish a release with:

```sh
pnpm sync:version
pnpm check:version
git tag "v$(cat VERSION)"
git push origin "v$(cat VERSION)"
```

The tag must equal `v` followed by the exact contents of `VERSION`. A
prerelease version such as `0.2.0-beta.1` creates a GitHub prerelease; other
versions become the latest release. Rerunning a successful tagged `Test`
triggers `Build` again and replaces the assets on an existing release.

Installers are currently unsigned. Code-signing identities and notarization
credentials should be configured before treating the packages as a general
public distribution.
