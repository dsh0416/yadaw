# Continuous integration and releases

The `CI`, `Test`, `Build`, and `Publish` GitHub Actions workflows are the
source of truth for validation, packaging smoke builds, and tagged releases.

## Workflows

- **CI** (`.github/workflows/ci.yml`) runs on pull requests and pushes to
  `main`. It calls the reusable Test and Build workflows in parallel, then
  reports their combined result through the stable `Gate` job. Configure
  the `Gate` check (shown under the `CI` workflow) as the only required status
  check for pull requests.
- **Test** (`.github/workflows/test.yml`) runs repository checks on Linux x64,
  Windows x64, and macOS. It is reusable through `workflow_call` and can also
  be started manually.
- **Build** (`.github/workflows/build.yml`) packages installers for Windows
  x64, Linux x64 and arm64, and universal macOS as a packaging smoke test. It
  is reusable through `workflow_call` and can also be started manually.
- **Publish** (`.github/workflows/publish.yml`) runs on a `v*` tag, validates
  that the tag matches `VERSION`, calls the reusable Test and Build workflows,
  and creates a draft GitHub Release only after both succeed.

## Workflow tiers

- Pull requests and pushes to `main` run `CI`, which calls `Test` and `Build`.
  The `Gate` job succeeds only when both reusable workflows succeed.
  Installers remain available as workflow artifacts for 14 days.
- Manual `workflow_dispatch` runs are available on `CI`, `Test`, and `Build`.
- Tags beginning with `v` run `Publish`, which calls `Test` and `Build`. After
  both succeed, `Publish` downloads the Build artifacts and adds the
  installers, a `SHA256SUMS` file, generated release notes, and (for public
  repositories) GitHub artifact attestations to a draft GitHub Release.

The Test and Build workflows install the versions in `mise.lock`, use frozen
pnpm dependencies, and pin the VST3 SDK commit where a native setup is
required. The mise installation, pnpm store, Cargo downloads, and Electron
downloads have separate platform-and-architecture cache keys. Rust compilation
uses sccache's GitHub Actions backend. The Cargo `target` directory is
deliberately not cached because it is large and can retain stale
platform-specific build state.

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
