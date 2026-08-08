# Contributing to Heron

Thank you for contributing. Heron is experimental and under active development;
thoughtful patches, reviews, bug reports, and design discussion all help.

## Getting started

Use the project-managed toolchain and validation path:

```sh
mise install
mise run check
mise run dev
```

## Normative project rules

All contributions must follow the repository governance index and the rules
applicable to the changed scope:

- [Governance index and precedence](agents/docs/README.md#adoption-and-precedence)
- [Engineering standards](agents/docs/engineering-standards.md)
- [Architecture and real-time constraints](agents/docs/architecture.md)
- [Product interaction design](agents/docs/interaction-design.md)
- [Architecture decision records](agents/docs/adr/README.md)
- [Product roadmap](agents/docs/roadmap.md)
- [Development environment](agents/docs/environment.md)
- [Agent guide](AGENTS.md) (conventions used by automation and humans alike)

Review every document that applies; a documentation-only or isolated internal
change need not pretend to affect every domain. Material changes to ownership,
process/thread boundaries, persistence, protocols, real-time assumptions,
foundational dependencies, compatibility, or Logic interaction semantics need
an ADR before implementation assumes the decision is accepted. Policy
exceptions and deferred correctness work must link to an issue.

## Pull requests

Fill in the repository pull request template, and:

- Use a [Conventional Commits](https://www.conventionalcommits.org/) title
  (for example `feat(desktop): …`, `fix(audio-host): …`, `chore: …`).
- Prefer small, reviewable changes with a clear purpose.
- Complete the governance review in the pull request template, using `N/A` only
  with a short reason.
- Match existing style and architecture; do not drive-by reformat unrelated code.
- Keep Electron IPC, UI work, filesystem access, allocation, and blocking
  synchronization out of real-time audio callbacks.
- Do not cross the renderer / native boundary incorrectly: the renderer talks
  only through the typed `window.heron` preload API.
- Ensure submissions are compatible with the
  [GNU General Public License v3.0](LICENSE). Do not paste code of unknown
  origin or with a conflicting license.
- Avoid low-signal volume: mass drive-by refactors, speculative “cleanup”
  sweeps, or batches of weakly related PRs are likely to be declined.

Maintainers may ask for tests, a narrower diff, or a short explanation of why a
change preserves real-time and process invariants.

## AI-assisted and AI-generated contributions

Heron **welcomes** AI-assisted and AI-generated code. Building a
cross-platform DAW involves a large surface area and a lot of careful,
repetitive engineering. Used well, AI can raise both delivery speed and
implementation quality.

The project does **not** reject contributions because they were produced with
AI. The same quality bar applies as for fully human-authored work.

### Human responsibility

Any commit or pull request that AI authored or helped produce must have a human
owner who:

1. Understands the change well enough to explain it in review.
2. Can fix defects the AI introduced.
3. Accepts full responsibility for the result—as if they had written every line.

“The model wrote it” is not a reason to merge unsafe, incorrect, or unmaintainable
code, and it is not a reason to leave bugs unfixed later.

### Review

AI-involved changes require substantive human review by at least one person who
meets the bar above. Rubber-stamp approval is not enough: the reviewer should
read for intent, boundaries, and failure modes, and should be able to repair
mistakes.

If the pull request author is the only person who has examined the change,
prefer a second reviewer who knows the affected subsystem before merge—
especially for high-risk areas:

- Real-time audio callbacks and lock-free in-process native paths
- `unsafe` Rust, FFI, and native addon boundaries
- Device and driver integration
- Security-sensitive surface (preload API, IPC validation, plug-in hosting)

Tests generated or extended by AI must be checked by a human. Green CI is not
sufficient if assertions miss the real requirement or quietly weaken coverage.

### Attribution and disclosure

- The git committer should be the responsible human. Co-Author trailers that
  name an AI tool are **not** required.
- Mentioning AI use in a pull request description is **optional**. Maintainers
  must not reject a change solely because AI was or was not disclosed.

### Maintainer discretion and newcomer space

Some AI-involved pull requests may still be declined or deferred. That is not a
ban on AI; it protects review bandwidth and leaves room for newcomers to learn
the codebase and join the community. Reasons include, without limitation:

- Work reserved for newcomers (for example issues labeled for first-time
  contributors)
- Diffs that are too large to review carefully, or that ignore documented
  architecture constraints
- Duplicate or already-decided work
- Low-signal or spam-like contribution patterns

Maintainer judgment is final in these cases; contributors need not litigate
whether a change “counts” as AI-authored.

## Issues

Use the GitHub issue templates for bug reports and design / feature discussion.
Prefer a clear reproduction, expected versus actual behavior, and platform
details when relevant. AI may help draft issues; the report itself should still
be accurate and actionable. Do not open floods of speculative or duplicate
tickets.

## License

By contributing, you agree that your contributions are licensed under the
[GNU General Public License v3.0](LICENSE).
