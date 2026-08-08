# ADR-0005: Build new projects from a migrated database template

- Status: Accepted
- Date: 2026-08-09
- Owners: project maintainers
- Related: `agents/docs/project-database.md`

## Context

Creating a project from an empty PGlite data directory runs PGlite `initdb` and
the complete Drizzle migration history before Heron can insert the initial
project graph. The migration portion grows as the project format evolves, even
though every new project needs the same current schema. This puts historical
upgrade work on a latency-sensitive user path and makes new-project time grow
without adding user value.

The project archive is already a PGlite data-directory dump, and the desktop
build already packages the committed migrations for opening older archives.
New-project seed data includes request- and runtime-specific values, including
the project configuration and built-in plug-in architecture, so it cannot all
be fixed on the build host.

## Decision

The Electron main build generates a gzip-compressed, schema-only PGlite template
archive from the committed Drizzle migrations. Template generation uses the
same migrator as runtime project upgrades, writes the output atomically, and is
a required build step. The template is packaged beside the main and project
worker outputs.

The project worker creates a new working database by loading that template into
the new `pgdata` directory. It does not run the migrator on this path. It then
inserts the project row, musical maps, default Mixer graph, built-in metronome,
and plug-in state in the existing single creation transaction. Consequently,
the template contains no project instance rows or build-host architecture.

Opening an existing archive or recoverable working copy continues to run the
complete migrator. The migration directory remains a packaged runtime resource
and the template does not change project compatibility policy.

A missing or invalid bundled template is an invariant violation. Packaged
applications do not silently fall back to empty-database initialization and
runtime migration; production build and worker smoke checks must catch a
packaging failure before release.

## Alternatives rejected

### Run every migration when creating a project

This retains the growing latency that motivated the change and makes old
upgrade work part of every new-project operation.

### Package a completely seeded project

This requires placeholder project configuration and can persist build-host
values such as `process.arch`. Updating or deleting every placeholder after a
copy is more fragile than keeping the small seed transaction runtime-owned.

### Recursively copy a raw `pgdata` directory

This couples packaging to PGlite's physical filesystem layout and copies many
files through Electron's archive layer. `dumpDataDir` and `loadDataDir` are the
existing supported archive boundary and provide one immutable build artifact.

## Consequences

- New-project time no longer grows with the Drizzle migration history.
- PGlite startup, template extraction, the seed transaction, and the initial
  durable `.heron` save remain on the creation path and must still be measured.
- Main builds spend additional time creating the template. Watch builds reuse
  it until a migration input changes.
- Changing PGlite or the migration history requires a newly generated template;
  the build owns this regeneration rather than source control.
- The template increases unpacked application size by one empty PGlite archive.

## Verification

- Project-database integration tests load the generated template, verify that
  it has the complete migration journal and no project row, and exercise the
  existing seed, migration-idempotency, graph, and archive tests through it.
- Desktop project-worker tests retain the typed creation boundary.
- The production main build must contain both `out/drizzle` and
  `out/project-template.pglite.gz`.
- A built project worker must create and reopen a project from the packaged
  resources on supported build hosts.

## Reconsider when

Reconsider the physical template when PGlite changes its data-directory format
or provides a faster portable logical snapshot. Reconsider seed placement only
if all project creation inputs become compile-time constants across every
target architecture.
