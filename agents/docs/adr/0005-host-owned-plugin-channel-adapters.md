# ADR-0005: Keep plug-in channel adapters host-owned

- Status: Accepted
- Date: 2026-08-09
- Owners: project maintainers
- Related: `agents/docs/architecture.md`

## Context

Mixer audio modes describe the signal contract of an insert in the channel
strip. A third-party processor may expose fewer native layouts than the host can
provide safely. In particular, a mono processor exposes 1-in/1-out while a mono
channel may need the insert to widen the following chain to stereo.

Treating `mono-to-stereo` solely as a native 1-in/2-out capability rejects valid
mono processors. Conversely, attempting a native layout after an isolated probe
has rejected or crashed on it risks terminating the embedded audio runtime.

## Decision

Persisted project `audioMode` remains the host-facing channel-strip contract.
Catalog `supportedAudioModes` records layouts proven by the native probe. The
host resolves the processor layout independently:

- native 1-in/2-out is preferred for `mono-to-stereo` when proven safe;
- otherwise a proven native 1-in/1-out processor is loaded and the format-neutral
  processor handle duplicates its processed left output into the right output;
- a mode with neither an exact native layout nor a defined host adapter is
  rejected before native loading.

The compiled graph carries an explicit `duplicate_mono_output` flag. Duplication
runs after successful native processing, without allocation or blocking, and is
not applied to bypass or unavailable processors because their host passthrough
already preserves the selected channel topology.

## Alternatives rejected

### Require native 1-in/2-out support

This makes the plug-in's bus arrangement define the channel strip and prevents
ordinary mono effects from widening a mono chain even though the host can do so
deterministically.

### Retry an unproven native layout in the embedded runtime

This preserves native widening when it happens to work, but repeats a path that
may already have crashed in the isolated probe. An in-process plug-in crash can
terminate Electron main under ADR-0001.

### Persist the resolved processor layout

Native capabilities may change after a plug-in update or rescan. Persisting the
derived layout would stale the project; it is resolved from the current catalog
each time the graph is prepared.

## Consequences

- Mono effects are selectable as `mono-to-stereo` effects.
- Native widening behavior remains available when the plug-in proves 1-in/2-out.
- The main/native graph ABI gains a backward-compatible boolean adapter field.
- Other format-neutral channel adapters must follow the same explicit,
  allocation-free post-processing model.

## Verification

Contract tests verify native layout resolution. Project and renderer tests verify
that mono effects accept the hosted mode. Main-process tests verify native mono
loading and graph adapter emission. `heron-audio-plugin` tests verify processed
left-channel duplication, and VST3 smoke tests verify isolated native layouts.

## Reconsider when

Replace this decision if the graph gains a general typed channel-layout system
that represents adapters as first-class render nodes without format-specific
knowledge or real-time allocation.
