# Engineering standards

These rules apply to hand-authored production code, build tooling, tests, and
architecture changes in this repository. `MUST`, `MUST NOT`, `SHOULD`, and
`MAY` are normative. A rule that can be checked mechanically should become a
repository check. A rule that requires judgment belongs in the review
checklist.

The standards optimize first for the maintainer, then for AI agents and external
contributors. Prefer explicit ownership and checkable constraints over a clever
abstraction whose safe use depends on oral history.

## Change discipline

- A change MUST have one stated user, product, maintenance, or reliability
  outcome. Incidental cleanup must remain reviewable.
- New behavior MUST define normal, unavailable, busy, failed, and recovery
  states where applicable.
- A bug fix MUST first add an automated reproduction that fails for the reported
  behavior. When automation is genuinely impossible, the change description
  MUST state why and give a repeatable manual check.
- Implementation, tests, agent-facing documentation, and shipped user
  documentation MUST change together when their shared behavior changes.
- `TODO` and `FIXME` comments MUST link to a tracked issue. Comments without an
  owner or durable tracking reference are forbidden.
- Do not edit APM-installed files under `.agents/skills/`; update `apm.yml` and
  regenerate through the locked APM workflow.

## Ownership and dependency direction

Keep the existing process and package structure. Split modules by feature or
runtime ownership, not by arbitrary categories such as `types`, `helpers`, or
`utils`.

### Renderer

- A presenter receives serializable props and emits intent. It MUST NOT read a
  Pinia store, Router, Electron API, project database, or `window.heron`.
- A controller, route view, or store may compose product state. Native and main
  work MUST go through the typed preload API.
- Renderer code MUST NOT import `@heron/dsp-node`, a project-database driver, or
  Reka primitives directly. Shared Reka behavior enters through `@heron/ui`.
- Application composition roots and route views remain thin. Reusable domain
  behavior belongs with the owning feature or store, not in the root view.

### Shared packages

- `@heron/contracts` contains serializable protocol and public application
  types. It MUST NOT depend on Electron, Vue, Pinia, native bindings, or a
  persistence implementation.
- `@heron/project-model` owns pure project invariants and transformations. It
  MUST remain usable without Electron or a database connection.
- `@heron/project-db` is the only project persistence implementation. Renderer
  code MUST NOT consume Drizzle rows or create a database proxy.
- `@heron/ui` owns visual behavior and accessibility. It MUST NOT own routing,
  stores, preload calls, product persistence, or DAW workflow policy.

### Electron main and preload

- Preload exposes the narrow typed `window.heron` surface and adapts transport;
  it MUST NOT own application policy or durable state.
- An IPC handler validates and authorizes a request, resolves explicit resource
  handles, calls one application service, and serializes the result. Business
  workflows do not accumulate in handler files.
- Application services own orchestration and the single commit point. Database
  and native calls enter through owned adapters.
- Electron main is the only JavaScript process allowed to import
  `@heron/dsp-node`.

### Native runtime

- `dsp-core` remains runtime-agnostic. Format-specific plug-in concepts MUST NOT
  leak into the audio engine or render graph.
- The embedded runtime MUST NOT depend on Electron or renderer code.
- The audio callback MUST NOT allocate, block, log, touch the filesystem, call
  N-API/Electron IPC, or acquire a lock that can be held by a control, plug-in,
  device, or filesystem call.
- Callback work and queues are bounded. Overflow, stale generation, and dropped
  work are explicit and observable.

## Stateful boundary work

Every cross-process, stateful, fallible workflow MUST document and test:

1. its states and legal transitions;
2. explicit resource handles and revision or generation rules;
3. the single durable commit point;
4. prepare/abort cleanup;
5. the data state after each failure;
6. idempotency or an operation-status reconciliation path; and
7. the user-visible recoverable or quarantined state.

Rejected promises, exceptions, Rust panics, ambient “current project/device”
state, timeouts with an unknown mutation outcome, and free-form error strings
MUST NOT become protocol semantics. Detailed internal causes may be logged; the
boundary returns a stable typed code and structured context.

## Error handling

### TypeScript

Internal TypeScript may throw `Error` subclasses when one caller owns the whole
operation and no commit outcome becomes ambiguous. Catch only to recover, add
meaningful context while preserving the cause, translate at an ownership
boundary, or perform cleanup. Do not catch merely to log and continue.

Across renderer/main and main/native boundaries, operations return serializable
success/error unions. A stateful timeout MUST NOT claim failure when the
mutation may still commit.

### Rust and native boundaries

- Recoverable device, plug-in, filesystem, input, and protocol failures return a
  typed `Result`.
- Production code MUST NOT use `panic!`, `unwrap()`, or `expect()` to handle
  runtime input or external failure.
- An `expect()` used for a proven invariant MUST explain that invariant next to
  the call. Tests may use panic-based assertions and setup.
- A panic MUST NOT unwind through N-API, a plug-in ABI, a platform callback, or
  an audio callback.
- Callback failure becomes a bounded state, counter, or non-blocking control
  signal; it never performs recovery work in the callback.
- `unsafe` code states the safety preconditions, ownership, thread affinity, and
  lifetime assumptions at the smallest practical boundary.

## Source size and module cohesion

Line count is a review signal, not a substitute for design judgment.

- A new hand-authored production file MUST NOT enter the repository above 800
  physical lines.
- An existing production file above 800 lines triggers mandatory ownership and
  cohesion review whenever it is materially changed.
- A hand-authored production file above 1200 lines MUST be split. An exception
  requires a linked issue and must not permit the file to grow.
- Test files, generated sources, ABI declarations, and mechanically derived FFI
  surfaces MAY exceed the thresholds when splitting would reduce auditability.
  The exception must be identified by the source audit rather than inferred
  from size alone.
- Splitting into generic `types`, `helpers`, or `utils` buckets does not satisfy
  this rule. Each extracted module owns a named behavior, feature, protocol, or
  runtime boundary.
- Binary entry points, package barrels, route views, and application composition
  roots SHOULD be substantially smaller than the general threshold.

Run `pnpm audit:source-size` to produce the inventory. The stricter
`pnpm check:source-size` command is part of the default `lint` pipeline and
rejects hand-authored production files above the 1200-line hard threshold.
CI can pass newly added source paths to
`node scripts/source-size-policy.ts --check-new <paths...>` to reject a new
production file above the review threshold without waiting for the full hard
gate.

### Adoption record

The first audit on 2026-08-08 found seven hand-authored production files above
the 1200-line hard threshold. They were resolved before enabling the default
gate:

| Baseline | Primary file after split                                              | Extracted ownership boundary                                     |
| -------: | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
|     1825 | `crates/vst3-host/src/processor.rs` (1010)                            | bus negotiation/lifecycle and processor tests                    |
|     1767 | `crates/vst3-host/src/hosted.rs` (1145)                               | processor leases, VST interfaces, and hosted-plug-in tests       |
|     1691 | `crates/audio-engine/src/midi_input.rs` (971)                         | MIDI input tests                                                 |
|     1565 | `crates/audio-host/src/editor_platform.rs` (161)                      | Windows, macOS, Linux, and unsupported platform implementations  |
|     1524 | `crates/audio-host/src/ara.rs` (1011)                                 | ARA audio, archive, model, playback, and timeline host providers |
|     1517 | `crates/audio-host/src/runtime/ui_runtime/embedded_editors.rs` (1164) | native editor attachment, scaling, geometry, and teardown        |
|     1439 | `crates/audio-host/src/vst3.rs` (1183)                                | VST3 instance behavior and runtime tests                         |

The audit now reports zero hard violations. Files between 801 and 1200 lines
remain review triggers rather than grandfathered exceptions; material changes
must still demonstrate cohesive ownership or split the file further.

The audit also finds review-trigger files between 801 and 1200 lines, including
audio bounce, project graph validation, macOS capture, embedded runtime,
VST3/CLAP host modules, recording, the main audio-host service, and `xtask`.
The generated audit output, rather than this prose snapshot, is authoritative
for current counts.

## Testing by risk

| Change                                                                       | Required primary evidence                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Pure calculation, parser, state transition, or project invariant             | Focused unit tests with boundary and invalid cases                                                          |
| Database schema, repository, archive, native binding, or protocol adapter    | Integration or contract tests with real serialization/storage where practical                               |
| Vue component with multi-step, keyboard, focus, overlay, or failure behavior | Vue Test Utils or Storybook interaction test; Playwright for browser/Electron integration risk              |
| User journey, recovery choice, routing mutation, or project lifecycle        | E2E test through the public product boundary                                                                |
| Audio callback, queue, graph publication, or DSP                             | Allocation invariant, concurrency/overflow tests, and a benchmark or soak appropriate to regression risk    |
| Platform device or plug-in integration                                       | Platform CI where deterministic plus recorded manual hardware evidence where CI cannot represent the device |

A coverage percentage does not replace the risk-specific evidence. Tests assert
observable behavior and stable contracts, not private call order. Snapshot-only
tests are insufficient for interactive or failure behavior.

## UI and interaction completion

New UI MUST:

- use the shared design tokens and primitives or document why a DAW-specific
  control is necessary;
- define applicable default, hover, focus, pressed, selected, disabled, busy,
  invalid, empty, and error states;
- support keyboard operation and focus restoration;
- cover dark and light themes and reduced motion;
- keep non-canvas content usable at 320 CSS px and 200% text zoom; and
- provide specific recovery copy for user-visible failure.

Follow [Interaction design](interaction-design.md) for product behavior and
[Design system](design-system.md) for visual and component rules.

## Architecture decisions and exceptions

Create an ADR for the triggers listed in [ADR governance](adr/README.md). A
policy exception MUST link to an issue. An issue link is sufficient at the
current project scale; do not invent a parallel waiver bureaucracy.

Exceptions are narrow: they identify the file, rule, and reason. They MUST NOT
silently authorize similar code elsewhere or allow the affected scope to grow.

## Review checklist

- The owner and dependency direction are clear.
- Public and cross-process types are serializable and stable enough for their
  stated compatibility period.
- The mutation has one commit point and a known failure state.
- Real-time and thread-affine work stays on its required side of the boundary.
- Failure reaches the user through the correct interaction layer.
- Tests match the highest-risk changed behavior.
- Source-size review resulted in a cohesive module, not mechanical extraction.
- Documentation and roadmap state describe shipped behavior accurately.
- Every TODO, exception, and deferred correctness issue links to an issue.
