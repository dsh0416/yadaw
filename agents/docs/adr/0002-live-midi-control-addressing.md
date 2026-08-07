# ADR-0002: Address Live MIDI controls by ordered channels and plug-in aliases

- Status: Proposed
- Date: 2026-08-08
- Owners: project maintainers
- Related: `agents/docs/product-live.md`

## Context

Live performers need global hardware mappings that survive project changes and
controller disconnects. Mixer channels and plug-in instances are project-owned,
so a global preference cannot safely persist their database IDs. Current scope
does not include a full control-surface protocol, bank model, soft takeover, or
hardware feedback.

## Decision

Application preferences map a physical MIDI device ID and message address to a
semantic target.

- Mixer targets use an index into the current shared ordering of Audio,
  Instrument, BUS, Output, and Master channels. Reordering intentionally changes
  the controlled channel.
- Current Mixer parameters are Gain, Pan, Mute, and Solo. Send is excluded.
- Mute and Solo mappings configure toggle or absolute behavior.
- Plug-in targets use a project-unique `controlAlias` plus stable parameter key.
  Display names may repeat. Moving the instance preserves its alias.
- A missing ordered index or alias ignores the message and does not retarget.
- Mappings remain after device disconnect and resolve by device ID on reconnect.

## Alternatives rejected

### Persist project resource IDs in preferences

IDs have no stable meaning across projects and would create accidental or dead
references.

### Persist mappings in each project

This accurately identifies instances but makes the physical controller layout
project-specific, contrary to the desired system configuration.

### Context-sensitive current selection

Mapping to “selected channel” or “selected plug-in” creates a live risk: a focus
or selection change can redirect a physical control without an obvious hardware
state change.

### Stable Live slots or control-surface banks

These avoid order-based retargeting but add a second channel assignment model.
The Current product explicitly chooses familiar visible Mixer order instead.

## Consequences

- Users must understand that Mixer reorder changes ordered targets.
- Alias uniqueness is a project invariant, while mappings remain application
  preferences.
- Missing targets are deliberately silent during performance.
- The model can add new semantic targets later but must not silently reinterpret
  an existing target kind.

## Verification

Contract tests cover preference validation, device IDs, target kinds, toggle and
absolute behavior, alias uniqueness, missing targets, reorder behavior, plug-in
moves, and persistence across relaunch. E2E covers multiple devices and projects.

## Reconsider when

Reconsider if users require banked control surfaces, stable channel slots,
soft takeover, or bidirectional hardware feedback.
