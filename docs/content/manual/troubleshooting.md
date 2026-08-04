---
title: Troubleshooting
description: Resolve silent output, unavailable inputs, dropouts, latency, and plug-in failures.
vstTrademark: true
asioTrademark: true
---

# Troubleshooting

Start with the status bar and the warning shown by Heron. They report the
active device state rather than only the requested settings.

## There is no sound

1. Confirm that the status bar says **Audio active**.
2. Open **Settings → Audio → Devices** and select the intended output.
3. Check the channel's output route and the hardware-output mapping.
4. Make sure the channel, buses, and master are not muted.
5. Check that no other channel is soloed.
6. Look for meter activity from the source toward the master.
7. Bypass plug-ins one at a time to find an insert that is blocking audio.

If meters move but speakers stay silent, the problem is probably after the
master channel: hardware mapping, operating-system routing, interface controls,
or cabling.

## An input is missing

1. Confirm that the operating system can see the device.
2. Allow microphone or audio-input permission for Heron.
3. Select the device under **Audio → Devices** and apply the change.
4. Reopen the audio channel's input selector.
5. On Windows, install and select the manufacturer's 64-bit ASIO® driver when
   appropriate.

## No audio device can be opened at all

When no backend reports a usable device, or another application is holding the
interface, select the **Mock** backend under **Settings → Audio → Devices**. It
starts the engine without touching hardware, so you can keep editing, arranging,
and configuring the project, and it lets Heron report the rest of its state
normally. Playback is discarded while it is selected, so switch back to a
hardware backend to hear the session.

## Input monitoring is unavailable

Enable software monitoring under recording settings, select a hardware input
on the audio track, and make sure the audio engine is active.

## Audio crackles or reports XRUNs

- increase the I/O buffer;
- close CPU-heavy applications;
- bypass expensive plug-ins;
- avoid running an audio performance benchmark during a session;
- check the performance monitor for CPU and deadline pressure;
- use one clocked interface for input and output when possible.

Separate input and output devices can require drift correction. That is
supported, but one interface is usually easier to tune.

## Monitoring latency is too high

Reduce the buffer gradually while watching for XRUNs. Disable unnecessary
plug-ins in the monitored path and use the round-trip latency readout to compare
configurations. Direct hardware monitoring, when offered by the interface, can
avoid the software round trip.

## A VST® 3 plug-in is absent or quarantined

1. Check that the correct architecture and VST 3 version are installed.
2. Open the Sound Browser and select **Rescan VST3**.
3. Restart Heron after installing or updating the plug-in.
4. Check startup messages for the failed module.
5. Remove or bypass a plug-in that repeatedly crashes the application while its audio graph is active.

Heron preserves a legal route when a stored plug-in cannot load, so the rest of
the project can remain usable.

## The project did not close cleanly

On the next open, choose **Recover working copy** when Heron reports that the
working state is newer than the saved archive. Choose **Open last saved** only
when you intentionally want to discard the newer working state.

For an interrupted recording, let Heron recover and finalize available swap
audio before moving or deleting the swap directory.

## Ask for help

Search existing [GitHub issues](https://github.com/minori-live/heron/issues) before
opening a report. Include:

- operating system and Heron version;
- audio interface, driver, sample rate, and buffer;
- the exact warning or error;
- steps that reproduce the problem;
- whether the issue remains with plug-ins bypassed.

Do not attach a private project or recording unless you have removed sensitive
material and explicitly intend to share it.
