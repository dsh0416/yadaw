---
title: Record audio
description: Choose an input, arm a track, monitor it, and capture audio safely.
---

# Record audio

Recording requires an active input device, an audio track, and a selected
hardware input.

## Prepare the system

1. Open **Settings → Audio → Devices**.
2. Select the input and output devices.
3. Apply the configuration and confirm that the status bar says **Audio active**.
4. In **Audio → Recording**, choose the recording format and swap location.

Use a buffer that is small enough to monitor comfortably but large enough to
avoid XRUNs. Start larger, then reduce it after the signal is stable.

## Prepare the track

1. Open the **Mixer** and add an **Audio** track.
2. In the channel's **Input** section, select a mono hardware input or link an
   adjacent pair for stereo.
3. Turn on **Record enable** for the track.
4. Turn on **Input monitoring** if you need to hear the input through YADAW.

Software monitoring must be enabled in recording settings, and the track must
have a hardware input, before input monitoring becomes available.

::: warning Feedback
Do not monitor an open microphone through nearby speakers. Use headphones or
turn monitoring off to prevent feedback.
:::

## Capture

Move the playhead to the start position, then select **Record** or press
<kbd>R</kbd>. Record-enabled audio tracks capture their selected inputs.

Select **Record** again to stop. YADAW closes the recording, repairs its audio
header, processes it into a project asset, and creates an arrangement clip.
Keep the application open while the finalization dialog is active.

## Recovery

During capture, audio is written to the configured swap directory. This allows
YADAW to recover a take if recording or the application stops before the
project archive is saved.

After a successful capture:

1. play the new clip and check it;
2. save the project archive;
3. keep an external backup for important work.

## If recording drops frames

An XRUN or dropout warning means the audio callback did not receive or deliver
data on time. Stop recording, increase the buffer size, close CPU-heavy
applications or plug-ins, and try again. YADAW reports dropped input or
captured frames during finalization rather than hiding the problem.
