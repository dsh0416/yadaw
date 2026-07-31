# Pre-feature Refactor Roadmap

This refactor is the architecture gate before new M1 product work. It is
implemented directly on `dsh0416/refactor-2` as a sequence of independently
revertible commits. Internal TypeScript, IPC, and native wire APIs may change
atomically, while existing project archives must migrate through the committed
Drizzle migrations.

## Target boundaries

- `@yadaw/contracts` owns serializable process and persistence contracts.
- `@yadaw/project-model` owns pure project commands, validation, inverse
  generation, classification, and selectors.
- The project database owns transactions and persistence, not project command
  meaning.
- A project track owns arrangement ordering and references exactly one ordinary
  audio or instrument mixer channel. Aux, master, output, and system channels
  do not own tracks.
- Renderer project state, project history, mixer runtime state, and
  feature-local selection state have separate Pinia owners and a one-way
  dependency graph.
- Electron main-process services expose narrow lifecycle facades around project
  command coordination, graph publication, audio-host supervision, recording,
  and plug-in runtime control.
- Rust uses ordinary modules with explicit imports and visibility. Generated
  bindings are the only allowed textual `include!`.

## Commit sequence

1. Lock compatibility and runtime characterization baselines.
2. Centralize project semantics in `@yadaw/project-model`.
3. Separate tracks from mixer channels across contracts and application code.
4. Migrate project databases and type worker operations.
5. Separate renderer project, history, and mixer runtime state.
6. Separate project command and audio graph coordination.
7. Split audio-host process supervision and session recovery.
8. Split recording session, finalization, and recovery.
9. Split plug-in catalog scanning and runtime control.
10. Normalize Rust core, client, and recording modules.
11. Normalize audio-host engine modules and thin the binary entry point.
12. Isolate native unsafe boundaries and extract the host protocol.
13. Extract Studio, Arrangement, and Piano Roll controllers.
14. Enforce the resulting architecture and update documentation.

## Completion gate

- Project command semantics have one implementation and apply/inverse
  conformance tests.
- Existing project archives migrate in a working copy and the source archive is
  not replaced until a successful save.
- Ordinary audio and instrument channels have exactly one track; clips address
  tracks and plug-ins/routes address mixer channels.
- Renderer store dependencies are acyclic and native calls remain behind the
  typed preload boundary.
- No hand-authored Rust source uses `include!`.
- Full formatting, linting, TypeScript, Vue, Rust, database, documentation,
  mock-backend E2E, real-time allocation, and benchmark-compilation checks pass.
- The refactor does not add M1 product functionality or introduce line-count
  based CI failures.

## Performance baseline

The existing `dsp-core`, `dsp-node`, `dsp-render`, IPC, and audio-host
benchmarks remain the comparison set. Structural changes must keep real-time
allocation tests at zero allocations. A repeatable median regression above five
percent is investigated before the responsible commit is accepted; generated
benchmark artifacts are never committed.
