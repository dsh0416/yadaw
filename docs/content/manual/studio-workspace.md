---
title: The studio workspace
description: Find the transport, timeline, Sound Browser, mixer, piano roll, and status bar.
vstTrademark: true
---

# The studio workspace

The studio keeps the arrangement in the center and opens supporting tools
around it.

## Top bar

The top bar is divided into functional groups:

- **Library** opens the Sound Browser.
- **Mixer** opens or closes the lower mixer dock.
- **Piano Roll** opens for the selected MIDI clip.
- The **transport** returns to the beginning, plays or pauses, and records.
- The **musical display** shows the playhead position, tempo, and meter.
- **Metronome** turns the metronome channel on or off.
- **Cycle** enables or disables playback of the selected loop range.
- **1234** enables a one-bar count-in before recording.
- The **master control** gives quick access to the master level and meter.

Dimmed controls labeled as coming soon are not available yet.

## Arrangement

The arrangement lines tracks up against a shared musical ruler. Global Tempo,
Meter, and Key lanes sit above the channel lanes. Audio clips show waveforms;
MIDI clips represent note regions.

The top 16 pixels of the ruler form the Cycle lane. Drag empty space there to
create a loop range, drag either edge to resize it, or drag the range itself to
move it. Cycle edits snap to beats and keep a minimum length of one beat.
Creating or editing a range enables Cycle automatically. If no range exists,
selecting **Cycle** creates a one-bar range around the playhead.

Cycle applies to internal-clock playback. It is unavailable while following
external MIDI Clock. During recording the button keeps its selected state, but
the loop takes effect only on later playback; recording never wraps at the
Cycle boundary.

Use the controls at the bottom of the arrangement to change:

- **Time** — horizontal zoom in pixels per quarter note;
- **Track** — lane height;
- **Gain** — waveform display scale, without changing audio level.

Double-click a zoom control to return it to its default.

## Sound Browser

Select **Library** to search:

- VST® 3 instruments;
- VST 3 audio effects;
- audio already stored in the project;
- the scanned plug-in catalog.

Use **Rescan VST3** after installing a new plug-in while Heron is open.

## Lower dock

The lower dock shows either the **Mixer** or **Piano Roll**. Drag the horizontal
divider to change its height. Opening one replaces the other; the arrangement
remains visible above it.

## Status bar

The status bar summarizes the audio engine:

- active or stopped state;
- sample rate and bit depth;
- I/O buffer size;
- current and average round-trip latency;
- XRUN count.

Select the performance indicator to inspect CPU, memory, timing, and audio
transport diagnostics when a session is under stress.
