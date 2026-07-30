---
title: Tracks and clips
description: Add channels, arrange audio and MIDI clips, and work with global musical lanes.
---

# Tracks and clips

Tracks connect the arrangement to mixer channels. A track's clips supply media
or MIDI events; its channel determines input, processing, routing, pan, and
level.

## Track types

Open the Mixer and use its add controls:

- **Audio** creates an audio track and channel for recordings or project audio.
- **Instrument** creates a MIDI track with a VST3 instrument input slot.
- **Aux** creates a return or submix channel without an arrangement lane.
- **Output** creates a hardware-output channel.

The project always has a master path. Deleting an audio or instrument channel
also removes its clips from the timeline, but keeps the underlying media assets
in the project.

## Rename and organize tracks

Double-click a channel or track name to rename it. Use
<kbd>Alt</kbd> + <kbd>↑</kbd>/<kbd>↓</kbd> while a track name is focused to
reorder it.

Channel colors identify related material in both the mixer and arrangement.
Open the channel menu to choose a color.

## Audio clips

Recordings appear as audio clips when capture finishes. The waveform is a
visual guide; changing the arrangement's **Gain** zoom changes only the drawing,
not the clip level.

Audio files stored in the project appear under **Library → Samples**.

## MIDI clips

On an instrument lane, double-click empty space to create a clip at that
position. You can also focus the lane and press <kbd>Enter</kbd>. Select a MIDI
clip to make the Piano Roll available.

To bring in an existing Standard MIDI File, use the MIDI import command. For
each sequence, choose a new instrument track or ignore it. You can keep the
project Tempo Track or replace it with the imported tempo map.

## Global lanes

The Tempo, Meter, and Key lanes describe the musical timeline. Expand a lane to
inspect its events. Tempo and meter affect musical positioning and MIDI import;
project key editing is still under development.
