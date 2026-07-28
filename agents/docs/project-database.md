# Project Database Development Rules

This document defines the implemented architecture and non-negotiable development
rules for the YADAW project database. It applies to all work involving PGlite,
Drizzle, project persistence, project archives, or database-facing IPC.

The former handwritten migration array, generic SQL proxy, and desktop-service
SQL transport were removed in the pre-release database rewrite. Do not
reintroduce them as compatibility layers.

## Source of Truth

`packages/project-db/src/schema.ts` is the only source of truth for the current
database structure.

- Define every table, column, default, primary key, foreign key, unique
  constraint, check constraint, and index in the Drizzle schema.
- Define physical foreign keys and Drizzle `relations()` metadata. Relations
  improve typed queries but do not create database constraints, so neither form
  may replace the other.
- Give self-references and multiple relations between the same pair of tables
  explicit names. Mixer output routing and send source/target relations must
  not depend on relation inference.
- Keep database column types and inferred TypeScript types aligned. Do not
  recreate database row interfaces by hand.
- Encode row-local invariants as schema constraints. Validate workflow and
  cross-row invariants in the typed repository transaction that performs the
  mutation.

The normalized project model has one truth source for each value:

- The `project` row owns project name, sample rate, and waveform display mode.
- Tempo and time-signature maps own musical timing. The event at tick zero is
  required by application transactions; tempo or time-signature snapshot
  columns must not be duplicated in `project`.
- A new project seeds its initial project row, 120 BPM tempo event, tick-zero
  time signature, Master, Output 1-2, and Audio 1 in one transaction after
  migrations complete.

## Migration Workflow

Use the Drizzle code-first migration workflow:

1. Change the Drizzle schema.
2. Run `mise exec -- pnpm db:generate`, backed by `drizzle-kit generate`.
3. Review the generated SQL and Drizzle metadata together.
4. Run `mise exec -- pnpm db:check`, project-database integration tests, and
   the desktop main production build.
5. Commit the schema change and generated migration artifacts in the same
   change.

The following rules are mandatory:

- Never hand-maintain TypeScript arrays of DDL statements or a custom migration
  journal.
- Never edit an existing generated migration or its metadata after it has been
  shared. Fix the schema and generate a new migration.
- Apply migrations in application code with
  `drizzle-orm/pglite/migrator`; do not loop over SQL strings with PGlite
  `exec`.
- The Electron main build must copy the committed migration directory to
  `out/drizzle`, and the project worker must resolve that directory relative to
  `import.meta.url`. Tests use the same committed migration directory directly.
- Migrations describe structure. Deterministic new-project seed data belongs in
  the project creation transaction, not in a data migration.
- A custom SQL migration requires an explicit review note explaining why
  Drizzle cannot express the change. It is an exception, not a convenience.

YADAW has not released a stable project format. Until that policy changes, old
development archives receive no migration, backfill, or compatibility
guarantee. A rewritten baseline may allow an old archive to fail naturally.
Do not add compatibility branches unless the product policy is changed first.

## Runtime Ownership and Process Boundaries

The native PGlite client and Drizzle database instance belong exclusively to
the project worker.

```text
Vue / Pinia
  -> named preload method
  -> validated Electron main handler
  -> ProjectService typed method
  -> typed project-worker request
  -> Drizzle + PGlite
```

- Do not expose SQL text, query methods, transaction batches, table names, or
  arbitrary predicates through contracts, preload, or worker protocols.
- Do not add a generic `query`, `execute`, `transaction`, or database command
  IPC channel.
- Renderer code must not create a Drizzle proxy or import persistence rows as
  UI models. Define narrow serializable DTOs in `@yadaw/contracts`.
- Main-process services call named `ProjectService` methods. The service owns
  dirty-state updates and refreshes session configuration when a mutation
  changes configuration or the tick-zero time signature.
- The worker protocol may use a discriminated union internally, but every
  operation must have typed input and output with one documented business
  purpose.

Typical worker operations include project configuration, asset summaries,
mixer persistence snapshots, atomic project commands, MIDI import, plug-in
state persistence, recording-track lookup, waveform cache lookup, and asset
deletion. Adding a new operation is preferable to reopening arbitrary SQL
access.

## Query and Transaction Rules

Use the native PGlite Drizzle driver and ORM/query-builder APIs for all ordinary
database work:

- Use typed `select`, relational queries, joins, inserts, updates, deletes,
  ordering, conflict handling, and returning clauses.
- Use `db.transaction()` in the worker for multi-step mutations. The
  `pg-proxy` driver does not provide a valid substitute for worker-owned
  transactions.
- Convert `ProjectCommand` patches with per-entity typed mappers and
  `.update(table).set(patch)`. Never interpolate table or column names.
- Batch related inserts where Drizzle supports them, including MIDI notes,
  MIDI events, waveform levels, and plug-in state updates.
- Preserve atomicity across persistence invariants. Channel deletion and
  rerouting, tempo-map replacement, MIDI source plus clip creation, project
  configuration updates, and asset cleanup must each commit or roll back as a
  unit.
- Return named typed objects. Do not pass `unknown[][]` row arrays across
  process boundaries or decode columns by numeric position.

## Raw SQL Policy

Raw SQL is forbidden for normal CRUD, joins, ordering, filtering, migrations,
or transaction orchestration.

There are only four allowed production exceptions:

1. Drizzle `sql` expressions inside schema declarations for constraints,
   partial indexes, and typed defaults that cannot be expressed by the column
   builder alone.
2. A single project-database infrastructure module for PostgreSQL large-object
   primitives such as `lo_create`, `lo_open`, `lowrite`, `lo_close`, `lo_get`,
   and `lo_unlink`.
3. A single save-time maintenance module for reading PostgreSQL's large-object
   catalog and executing `VACUUM (ANALYZE)`, which Drizzle cannot express as an
   ORM operation.
4. A single waveform infrastructure module for selecting one cached waveform
   level and returning a parameterized `substring(bytea)` window without
   materializing every complete level in JavaScript.

Large-object calls must be parameterized and run inside the same Drizzle
transaction as their asset-row changes. Asset deletion selects the stored OID,
deletes the asset, and unlinks the large object transactionally. Do not restore
the handwritten unlink trigger or spread large-object SQL into services.

Waveform slicing SQL must be parameterized, isolated to the documented module,
and preserve the typed `StoredWaveformWindow` interface. Ordinary waveform
metadata writes and cache replacement remain Drizzle operations.

Before creating a project archive, the worker compares
`pg_largeobject_metadata` with the asset table's OID references, unlinks
orphans in one transaction, then runs `VACUUM (ANALYZE)` outside that
transaction. Do not use `VACUUM FULL` in this path: PGlite archives the
physical data directory, and the rewrite can add enough WAL to make the
immediate archive larger. The final data-directory dump is uncompressed:
project large objects are predominantly already-compressed or high-entropy
audio, so gzip adds CPU and save latency without a reliable size benefit.

Generated migration `.sql` files are generated artifacts and are excluded from
the production-source raw SQL rule.

An architecture test must scan production sources and fail if SQL templates,
low-level PGlite `query`/`exec`, or generic SQL transport types appear outside
the schema and large-object allowlist. Update the allowlist only when this
document is deliberately amended.

## Required Verification

Every database change must cover the relevant checks below.

### Schema and migrations

- A blank PGlite data directory migrates to the complete current schema.
- Running the migrator again is idempotent.
- Foreign-key cascade/restrict behavior, self-relations, unique constraints,
  partial indexes, and check constraints are exercised.
- `drizzle-kit check` passes.
- The production main build includes `out/drizzle`, and the built worker can
  create a database from it.

### Repository behavior

- Typed reads and writes round-trip without manual row-position mapping.
- A forced failure in every multi-step write rolls the entire transaction back.
- Tempo and time-signature replacements reject maps without tick-zero events.
- Project session configuration and dirty state remain synchronized after
  configuration and project-command mutations.

### Media behavior

- Large-object import, cancellation, duplicate detection, archive round-trip,
  deletion, failure cleanup, and save-time orphan reclamation leave no
  orphaned large objects.
- Saved archives are uncompressed PGlite data-directory dumps and remain
  directly loadable through `loadDataDir`.
- Waveform cache replacement, version invalidation, level selection, and asset
  cascade deletion remain correct.

### Process boundary

- Contracts, preload, renderer, and main services contain no generic SQL API.
- Pinia stores call named preload methods only.
- The raw SQL architecture test passes.
- Project-database integration tests, desktop unit/type checks, the desktop
  main build, and the full `mise run check` path pass before handoff.

## Review Checklist

Reject a database change if any answer below is no:

- Is the schema the complete structural source of truth?
- Are both database foreign keys and Drizzle relations defined?
- Was the migration generated and applied by Drizzle tooling?
- Is the database operation owned by the project worker?
- Does the operation use a named typed interface instead of SQL transport?
- Is ordinary persistence expressed through Drizzle?
- Is any unavoidable SQL isolated to the documented allowlist?
- Are transaction rollback, constraints, packaging, and process boundaries
  tested?
