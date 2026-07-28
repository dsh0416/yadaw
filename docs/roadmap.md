# Roadmap

YADAW is experimental. This checklist is the agreed product backlog and
milestone order. Check items when they ship in a usable form; uncheck or add
items when scope changes. Releases document what each version actually
supports.

## Compatibility policy

Until **1.0**, the project does **not** promise backward compatibility for
project archives, preferences, IPC contracts, or plug-in state. Formats may
carry version markers to aid development, but there is no guaranteed upgrade
path for older sessions. Compatibility commitments begin with 1.0.

## Priorities (ordering constraints)

- [x] Prefer MIDI editing and the piano roll as the highest near-term product
      focus after foundation hardening
- [x] After VST3, host formats in order: ARA → CLAP → AU
- [x] Defer the full built-in rack until after Studio → Stage (M4), without
      blocking M1–M3
- [x] Accept breaking project-format changes freely before 1.0

## Vertical slice (baseline)

Already usable for experimentation; keep these checked as the floor.

- [x] Native real-time audio engine (cpal / audio-host)
- [x] Project persistence (open / save / reopen)
- [x] Arrangement timeline with audio clips
- [x] MIDI clip import, display, move, and playback
- [x] Mixer with BUS routing, sends, meters, and Master
- [x] Audio recording with pending recovery path
- [x] VST3 scan, insert, editor windows, and state sync
- [x] Built-in VST3s: Gain, Sine, Metronome
- [x] Mixer-oriented undo / project commands

## M0 — Foundation hardening

Make the existing vertical slice reliable for daily experimentation.

- [x] Recording pending recovery across stop / crash / relaunch (swap sidecars,
      `partial` → `ready` repair, commit into the open project; covered by e2e)
- [x] Plug-in failure / bypass / missing-module recovery (crash marker, helper
      restart with suspect bypass, missing/quarantined/failed UI states, graph
      keeps legal topology for missing slots)
- [x] Contributor-facing CI and multi-platform packaging (signed/notarized
      installers stay in M3)
- [x] Graph construction moves to the supervised graph worker (see
      `agents/docs/playback-runtime.md`)
- [x] Project Settings exposes session sample rate; recording finalization
      resamples to that rate
- [x] Audio engine session clock follows the project sample rate across device
      open / reconfiguration (streams still open at the device native default)
- [ ] Authoritative round-trip latency measurement (physical loopback; estimates
      from callback timestamps + ring occupancy exist today)

## M1 — Composition MVP

**Next primary focus.** Write and edit music inside YADAW without an external
DAW for MIDI work.

- [ ] Piano roll UI
- [ ] Note-level MIDI create / edit / delete
- [ ] Velocity and basic note properties editing
- [ ] MIDI clip trim / split (minimum useful set)
- [ ] Audio clip trim / split / fade basics (minimum useful set)
- [ ] Transport loop
- [ ] Count-in
- [ ] Arrangement undo covering edit operations (not only mixer commands)
- [ ] MIDI hardware input into the session

## M2 — Mix and deliver

Finish and hand off a mix.

- [ ] Channel automation (fader / pan / mute)
- [ ] Plug-in parameter automation
- [ ] Offline bounce / export of the full mix
- [ ] Stem export
- [ ] Mixer groups (or equivalent grouping workflow)
- [ ] ARA hosting
- [ ] CLAP hosting
- [ ] AU hosting

## M3 — Studio to stage

Live half of the product vision.

- [ ] Minimal live set / scene-oriented workflow
- [ ] Low-latency mode as a product feature
- [ ] Performance tooling usable outside developer diagnostics
- [ ] Wayland native VST3 editor path (beyond parameter-editor fallback)
- [ ] Signed / notarized release distribution

## M4 — Built-in rack

Large effort after M3. Out-of-the-box sound without third-party plug-ins for
common chains. Until then, rely on Gain / Sine / Metronome plus third-party
VST3. Opportunistic iced chrome polish may land earlier, but M4 formally starts
with a shared native visual language so new built-ins are not redesigned later.
This work must not block M1–M3.

### Native iced UI (do first)

- [ ] Define a shared iced design language (tokens, typography, controls) aligned
      with `@yadaw/ui` where practical
- [ ] Apply it to `audio-host` editor chrome and the generic parameter editor
- [ ] Apply it to existing built-ins (Gain, Sine, Metronome) via `yadaw-plugin-ui`

### Built-in processors (after UI language)

- [ ] Utility (gain / pan / phase / width-class basics)
- [ ] EQ
- [ ] Compressor / dynamics
- [ ] Saturator / distortion
- [ ] Reverb
- [ ] Delay
- [ ] Stronger instrument(s) beyond Sine (scope TBD)
- [ ] Built-ins remain real-time safe and match host width / bypass / state
      model

## Explicit non-goals for early 0.x

- No stable project-format guarantees before 1.0.
- Do not schedule CLAP or AU ahead of ARA.
- Do not block M1–M3 on a full built-in plug-in suite.
