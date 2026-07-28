# Continuous integration and releases

The `CI` GitHub Actions workflow is the source of truth for validation,
cross-platform packaging, and tagged releases.

## Workflow tiers

- Pull requests run the complete repository check on Linux and the Rust,
  renderer, and project-database test suites on Linux x64, Windows x64, and
  macOS arm64.
- Pushes to `main` run the same checks, then create installers for Windows x64,
  Linux x64 and arm64, and macOS x64 and arm64. The installers remain available
  as workflow artifacts for 14 days.
- Manual runs behave like `main` builds and are useful for validating packaging
  before a release.
- Tags beginning with `v` run every preceding gate and publish the five
  installers, a `SHA256SUMS` file, generated release notes, and (for public
  repositories) GitHub artifact attestations to a GitHub Release.

The workflow installs the versions in `mise.lock`, uses frozen pnpm
dependencies, and pins the VST3 SDK commit. The mise installation, pnpm store,
Cargo downloads, and Electron downloads have separate
platform-and-architecture cache keys. Rust compilation uses sccache's GitHub
Actions backend. The Cargo `target` directory is deliberately not cached
because it is large and can retain stale platform-specific build state.

## Creating a release

`VERSION`, the root package, all workspace packages, and the Cargo workspace
version must match before CI can pass. Prepare and publish a release with:

```sh
pnpm sync:version
pnpm check:version
git tag "v$(cat VERSION)"
git push origin "v$(cat VERSION)"
```

The tag must equal `v` followed by the exact contents of `VERSION`. A
prerelease version such as `0.2.0-beta.1` creates a GitHub prerelease; other
versions become the latest release. Rerunning a tagged workflow replaces the
assets on an existing release.

Installers are currently unsigned. Code-signing identities and notarization
credentials should be configured before treating the packages as a general
public distribution.
