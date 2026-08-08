# ADR-0004: Keep project media canonical and audition outside transport

- Status: Accepted
- Date: 2026-08-08
- Owners: project maintainers
- Related: `agents/docs/interaction-design.md`, `agents/docs/roadmap.md`

## Context

Heron had a partial left-side Sound Browser that mixed plug-in discovery with
project audio. Instruments, effects, and plug-ins already have an owning
surface in the Mixer, while imported audio and MIDI need durable project
identity, repeatable placement, and a low-latency preview path. Adding MP3 and
FLAC also requires a canonical representation so timeline playback does not
decode compressed media repeatedly.

This work changes renderer/main and main/native protocols, project asset
projection, workspace layout state, and the real-time callback's owned data.

## Decision

The right-side **Media Browser** owns the open project's audio and MIDI assets.
The left side owns only the contextual Inspector. Notes and Media Browser are
mutually exclusive right panels; the right panel starts closed, persists a
width from 260 to 480 CSS pixels, and defaults or keyboard-resets to 320 pixels.
No preference migration is provided for the removed Sound Browser layout.

Audio import accepts WAV/BWF, MP3, and FLAC. The native import task hashes the
source bytes, decodes outside the audio callback, rejects layouts other than
mono or stereo, and writes float32 BWF plus waveform levels before the project
database imports the large object. Equal source hashes reuse the first asset ID
and name. MIDI retains its original bytes in the project database and uses the
same hash-based identity rule.

Dragging a project audio asset to an Audio lane creates a clip; dropping it on
blank arrangement space first creates an Audio track. MIDI uses the existing
mapping dialog, preselecting an Instrument track when one was targeted and a
new track for blank space. Operating-system drops import first, so a later
placement failure retains the successfully imported asset and reports that
outcome.

Audio audition is a control-plane operation, not a transport or project
command. Main validates the asset and resolves the project's first stereo
Output, materializes the canonical BWF, and asks the embedded audio runtime to
replace the single current audition. Decoding and allocation occur off the
callback. The callback only swaps an owned buffer through its command ring,
mixes it directly into the selected hardware outputs, and retires replaced or
stopped buffers through a bounded ring for control-thread destruction. Audition
does not move the playhead, alter playback or recording state, create Undo
history, or persist state; it may run while transport playback continues.

Pre-1.0 project archives, preferences, and bundled protocol peers have no
compatibility guarantee; this change does not provide migration behavior for
the removed workspace layout state.

## Alternatives rejected

### Extend the left Sound Browser

That would preserve duplicate plug-in discovery outside the Mixer and compete
with the Inspector for a panel whose content is not contextual to track
selection.

### Reference compressed files in place

External paths can disappear, do not make a project self-contained, and would
move repeated decode work into playback-sensitive paths.

### Implement audition as a temporary timeline clip

That would couple preview to transport, selection, dirty state, and Undo, and
would make audition during playback harder to reason about.

### Build a global indexed sound library now

Folder indexing, tags, favorites, and background scanning have different
persistence and privacy requirements. They are deferred until the project-only
workflow is proven.

## Consequences

- Project asset summaries are a discriminated audio/MIDI union and always carry
  a content hash.
- Exact source-byte duplicates converge; separately encoded files with equal
  decoded PCM remain distinct assets.
- Imported compressed audio takes project storage proportional to decoded BWF.
- Only one audition can exist, and routing follows the first stereo Output
  currently published by the project graph.
- Import, placement, and MIDI mapping remain separate commit points; the UI must
  distinguish an import that succeeded from a placement that did not.
- Finished audition memory is retired when the UI issues its bounded-duration
  stop command, when another audition starts, or when the engine is destroyed.

## Verification

- Project database integration tests cover audio/MIDI asset projection, archive
  persistence, and MIDI byte recovery.
- Main-service tests cover canonical audio import, hash deduplication, first-name
  retention, stereo Output routing, and invalid audition targets.
- Renderer tests cover mutually exclusive panels, persisted bounds, the native
  call boundary, and top-bar actions.
- Audio-engine tests cover audition while stopped, transport position
  independence, replacement, stop, and concurrent playback state.
- Full TypeScript/Vue, Rust, localization, design, and project checks remain the
  release gate.

## Reconsider when

Reconsider the source-byte identity rule when cross-encoding PCM deduplication
has a measured storage benefit, or replace the in-memory audition buffer when
real projects demonstrate that bounded streaming audition is necessary.
