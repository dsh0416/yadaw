---
title: Record audio and MIDI
description: Arm tracks, monitor inputs, and capture audio or MIDI safely.
---

# Record audio and MIDI

Recording requires an active audio engine. Arm one or more audio tracks, instrument
tracks, or both before pressing Record.

## Prepare the system

1. Open **Settings → Audio → Devices**.
2. Select the input and output devices.
3. Apply the configuration and confirm that the status bar says **Audio active**.
4. In **Audio → Recording**, choose the recording format and swap location.
5. For MIDI hardware, open **Settings → MIDI Input & sync** and confirm the
   expected ports are available.

Use a buffer that is small enough to monitor comfortably but large enough to
avoid XRUNs. Start larger, then reduce it after the signal is stable.

## Prepare an audio track

1. Open the **Mixer** and add an **Audio** track.
2. In the channel's **Input** section, select a mono hardware input or link an
   adjacent pair for stereo.
3. Turn on **Record enable** for the track.
4. Turn on **Input monitoring** if you need to hear the input through Heron.

Software monitoring must be enabled in recording settings, and the track must
have a hardware or application input, before input monitoring becomes available.

### Record an application's audio

In the channel's **Input** menu, open **Applications** and select an application
that is currently producing audio. Heron captures the selected application and
its helper processes as one stereo source. This is supported by WASAPI Process
Loopback on Windows and by Core Audio Process Tap on macOS 14.2 or later.

The first macOS capture starts the system permission flow. Allow Heron under
**System Settings → Privacy & Security → System Audio Recording**, then restart
Heron. If access is denied or later revoked, the channel remains routed but is
silent and shows a permission message.

An application target is not rebound automatically after the application exits.
Restart the target, then select it again or disable and re-enable monitoring or
recording. A selected target that is temporarily unavailable remains visible in
the input menu so the project does not silently switch to another application.

Use **Low Latency Mode** to prioritize a live monitored main path while recording.
See [Low Latency Mode](low-latency-mode.md) for target Output selection, the
plug-in budget, and the alignment trade-offs involved.

::: warning Feedback
Do not monitor an open microphone through nearby speakers. When monitoring an
application, Heron also excludes its own process tree to prevent capture
feedback. Use headphones or turn monitoring off if another route feeds the
captured application back into itself.
:::

## Prepare an instrument track

1. Open the **Mixer** and add an **Instrument** track.
2. Open the **Inspector**, select the track, and choose its MIDI input port and channel, or leave
   **All Inputs** and **Omni** selected.
3. Turn on **Record enable** for the track.
4. Turn on **Input monitoring** if you want live MIDI to reach the instrument
   while you play.

Recording does not require monitoring. An armed instrument still journals MIDI
even when monitoring is off.

## Capture

Move the playhead to the start position, then select **Record** or press
<kbd>R</kbd>. Record-enabled audio tracks capture their selected inputs.
Record-enabled instrument tracks capture matching MIDI into a durable journal
and commit a MIDI clip when you stop.

Enable **1234** in the top bar for a one-bar count-in before capture begins.
The metronome sounds during the count-in even when the arrangement starts at
the recording position.

Cycle is a playback aid and never loops a recording. If Cycle is enabled while
you record, capture continues past the loop end and the saved Cycle range is
used again the next time you play.

Select **Record** again to stop. Heron closes the recording, repairs audio
headers when needed, processes audio into project assets, converts MIDI journals
into clips, and updates the arrangement. Keep the application open while the
finalization dialog is active.

## Recovery

During capture, audio and MIDI journals are written to the configured swap
directory. This allows Heron to recover a take if recording or the application
stops before the project archive is saved. Recovered MIDI takes close any
notes that were still held when capture ended.

After a successful capture:

1. play the new clip and check it;
2. save the project archive;
3. keep an external backup for important work.

## If recording drops frames

An XRUN or dropout warning means the audio callback did not receive or deliver
data on time. Stop recording, increase the buffer size, close CPU-heavy
applications or plug-ins, and try again. Heron reports dropped input or
captured frames during finalization rather than hiding the problem.
