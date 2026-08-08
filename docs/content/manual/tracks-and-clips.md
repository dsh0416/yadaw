---
title: Tracks and clips
description: Add channels, arrange audio and MIDI clips, and work with global musical lanes.
vstTrademark: true
---

# Tracks and clips

Tracks connect the arrangement to mixer channels. A track's clips supply media
or MIDI events; its channel determines input, processing, routing, pan, and
level.

## Track types

Open the Mixer and use its add controls:

- **Audio** creates an audio track and channel for recordings or project audio.
- **Instrument** creates a MIDI track with a VST® 3 instrument input slot.
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

Audio and MIDI files stored in the project appear in the right-side **Media
Browser**. Use its top-bar button to open or close it. The panel starts closed,
can be resized from its left edge, and shares the right side with Notes.

Use **Audio** in the Media Browser to import WAV/BWF, MP3, or FLAC files. Heron
copies supported mono or stereo media into the project as canonical float32 BWF;
files with more than two channels are rejected. Importing the same source
content again reuses the first asset and keeps its original name.

Select an audio asset and press <kbd>Space</kbd>, or use its play button, to
audition it through the current stereo Output. Audition is independent of the
transport and may continue while the arrangement plays. It does not create a
clip, change the playhead, dirty the project, or add an Undo step.

Drag audio from the Media Browser to an Audio track to create a clip. Drop it on
blank arrangement space to create an Audio track and clip together. You can
also drag supported files from the operating system; Heron imports them before
placing the clips. If placement fails after import, the Media Browser retains
the imported asset.

Drag a clip's left or right edge to trim it without changing the underlying
audio. Trimmed material remains available, so dragging the edge back out
restores it. Drag either handle along the top edge to set a fade-in or fade-out;
Heron renders the fades with a smooth equal-power gain curve.

Right-click a clip for **Split at playhead**, **Trim start to playhead**,
**Trim end to playhead**, **Reset fades**, and **Delete**. The playhead must be
strictly inside the visible clip for split and trim-to-playhead commands. A
split keeps the outside fades and starts both new cut edges with no fade.

## MIDI clips

On an instrument lane, double-click empty space to create a clip at that
position. You can also focus the lane and press <kbd>Enter</kbd>. Select a MIDI
clip to make the Piano Roll available.

Drag a MIDI clip's left or right edge to trim it to the current arrangement
snap. Hidden notes and events are preserved, so you can extend the clip again
later. Right-click for split, trim-to-playhead, and delete commands. Splitting
one or more selected MIDI clips at the playhead is one edit and one Undo step;
the resulting clips can be extended and edited independently.

To bring in an existing Standard MIDI File, use **MIDI** in the Media Browser.
For each sequence, choose a new instrument track, an existing Instrument track,
or ignore it. You can keep the project Tempo Track or replace it with the
imported tempo map. Dragging MIDI to an Instrument track opens the same mapping
dialog with that track preselected; dropping on blank arrangement space defaults
to a new Instrument track.

## Global lanes

The Tempo, Meter, and Key lanes describe the musical timeline. Use the
**Global Tracks** control to show or hide all three lanes. Tempo and meter affect
musical positioning and MIDI import; project key editing is still under
development.

### Supported meter denominators

Heron currently accepts meter numerators from 1 through 32 and the denominators
1, 2, 4, 8, 16, and 32. The same choices appear in Project Settings, the top-bar
musical display, and the Meter global lane. A missing value such as 11 is a
current limitation, not an input or project error.

The project timeline uses 960 pulses per quarter note (PPQ), so a whole note is
3840 ticks. Every supported denominator divides that duration into exact integer
tick positions. A meter such as 7/11 would instead make one notated beat
3840 / 11 ticks. That is not an integer, and allowing different parts of the
application to round these fractional positions separately could make bar
lines, snapping, count-in, the metronome, and plug-in timing disagree or drift
over time. Heron rejects such a denominator rather than silently approximating
it.

Standard MIDI Files have a separate compatibility limit: their Time Signature
event stores the denominator as a power of two, so a signature such as 7/11
cannot be represented losslessly in a `.mid` file regardless of its PPQ value.

If you need to sketch music based on an unsupported denominator, turn piano-roll
snap **Off** and place notes manually. The project must still use a supported
displayed meter, and its bar grid, metronome accents, and count-in will follow
that displayed meter. Supporting these meters correctly requires a shared
rational-meter grid; that can be added without changing the project's 960 PPQ
timebase, but is not implemented today.

## Undo and redo

Clip creation, movement, trim, split, fades, deletion, piano-roll note edits,
and Tempo, Meter, and Key lane edits use the same project history. **Undo** or
**Redo** restores the whole operation, including a multi-clip split, in one
step.
