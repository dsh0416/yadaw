---
title: MIDI and piano roll
description: Create or import MIDI clips and edit notes, timing, and velocity.
vstTrademark: true
---

# MIDI and piano roll

Instrument tracks hold MIDI clips and send their notes to a VST® 3 instrument.

## Create an instrument track

1. Open the **Mixer** and choose **Instrument**.
2. Select the empty instrument input slot.
3. Search for a VST 3 instrument and choose a supported audio mode.
4. Double-click the instrument lane in the arrangement to create a MIDI clip.

Double-click the instrument slot later to open the plug-in's editor.

## Import MIDI

Use the MIDI import command and select a Standard MIDI File. The import dialog
lists its sequences and note counts.

For each sequence:

- choose **New Instrument track** and optionally assign a VST 3 instrument; or
- choose **Ignore**.

Choose whether to keep the current project Tempo Track or import the file's
tempo map. Keeping project tempo places the MIDI at the playhead. Importing
tempo starts at tick zero and replaces the existing tempo map.

## Open the piano roll

Select a MIDI clip, then choose **Piano Roll** in the top bar. The lower dock
shows the editable clips, note grid, inspector, and optional velocity lane.

## Editing tools

- **Select** moves, resizes, and edits existing notes.
- **Draw** adds notes.
- **Erase** removes notes.
- **Snap** constrains note positions and lengths to the selected musical grid.
- **Quantize** moves selected note starts to the current snap grid.

The inspector edits pitch, start tick, duration, channel, velocity, and release
velocity for the current selection. Drag bars in the velocity lane for a visual
way to shape dynamics.

Snap choices include straight and triplet values from whole notes through
64th notes. **Off** retains integer tick precision without snapping to a note
division.

## Useful note-editing keys

Standard edit commands—cut, copy, paste, select all, undo, and redo—apply to
the active editor. The piano roll also supports keyboard-driven duplication,
octave transposition, and quantization; command hints in the editor reflect the
current selection and tool.
