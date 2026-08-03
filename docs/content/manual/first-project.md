---
title: Your first project
description: Configure audio, create a project, add a track, and save your work.
vstTrademark: true
---

# Your first project

This walkthrough gets sound through Heron and saves a small session.

## 1. Check the audio device

Open **Settings**, then choose **Audio → Devices**.

1. Select the output device connected to your speakers or headphones.
2. Select an input device if you plan to record.
3. Choose a buffer size. Start with the device default or a moderate value.
4. Select **Apply audio**.

The status bar reports the active sample rate, buffer, round-trip latency, and
XRUN count. If the audio engine does not start, see
[Settings and audio devices](settings.md).

## 2. Create the project

On the welcome screen, select **Create project** and choose where to save the
`.heron` archive.

A new project starts at:

- 48 kHz session sample rate;
- 4/4 meter;
- 120 BPM on the Tempo Track.

You can change the project name, sample rate, meter, and waveform display later
in **File → Project Settings**.

## 3. Add something to play

Open the **Mixer** from the top bar.

- Choose **Instrument** to add an instrument track, then assign a VST® 3
  instrument from the input slot or Sound Browser.
- Choose **Audio** to add an audio track. Select its hardware input before
  recording.

For an instrument track, double-click an empty point in its timeline lane to
create a MIDI clip. Select the clip and open **Piano Roll** to draw notes.

## 4. Use the transport

Select **Play** or press <kbd>Space</kbd>. The playhead moves through the
arrangement and the master meter shows output activity. Press <kbd>Home</kbd>
to return to the beginning.

Double-click the tempo value in the musical display to edit the Tempo Track
event at the current position.

## 5. Save

Choose **File → Save Project** or press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> +
<kbd>S</kbd>. The unsaved indicator beside the project name disappears after
the archive has been written.

::: info Working copy and archive
Heron keeps an active working copy while the project is open. Saving writes
that state and its media into the `.heron` archive. If the application closes
unexpectedly, Heron can offer to recover a newer working copy next time.
:::
