---
title: Settings and audio devices
description: Configure the audio engine, devices, recording, display, and mixer presentation.
---

# Settings and audio devices

Application settings apply across projects. Project settings describe the
current session.

## Audio engine

The engine page controls how the isolated native audio service runs. Use the
resolved values shown by YADAW when diagnosing which runtime configuration is
actually active.

If you change runtime options, let YADAW restart the audio helper before
resuming playback or recording.

## Audio devices

Choose input and output devices independently, then select their channel
configuration and requested buffer size.

YADAW can keep devices working when:

- input and output use different sample rates;
- devices have independent hardware clocks;
- their buffer sizes differ;
- the project sample rate differs from the output device.

The application reports when adaptive resampling, drift correction, or a buffer
fallback is active. These are useful compatibility mechanisms, but matching
device clocks and sample rates usually gives the simplest low-latency setup.

## Working without audio hardware

The backend list ends with **Mock**, which is always available and needs no
driver. It runs the engine, transport, mixer, and plug-ins normally, but it
never opens a real device: capture is silent and playback is discarded.

Use it to keep working when no interface is connected, when another application
is holding the device, or when you want to edit a project without producing
sound. YADAW selects it automatically only when no other backend can be reached.

Mock devices run at 48 kHz in stereo and route playback back into capture, so
metering and the round-trip latency measurement still respond. Switch back to a
hardware backend when you need to hear the session.

## Buffer size

Smaller buffers reduce monitoring latency and increase deadline pressure.
Larger buffers improve stability at the cost of latency.

If XRUNs appear:

1. increase the buffer;
2. close CPU-heavy applications;
3. bypass expensive plug-ins;
4. check the performance monitor for timing pressure.

## Recording

Recording settings control software monitoring, capture format, and the swap
directory used for recoverable in-progress takes. Put the swap directory on a
drive with enough free space and reliable write performance.

## Display

Choose:

- dark, light, or system-following color theme;
- English or Simplified Chinese interface language;
- general workspace presentation options;
- mixer display density and behavior.

Display and language changes apply immediately and are remembered on the
device.

## Project settings

Open **File → Project Settings** to edit settings stored with the project,
including the project name, session sample rate, musical meter, and waveform
display mode.

The meter denominator selector intentionally offers 1, 2, 4, 8, 16, and 32.
Other denominators are not currently supported; see **Supported meter
denominators** in [Tracks and clips](tracks-and-clips.md) for the timing and MIDI
compatibility details.

Changing session sample rate changes the project clock. YADAW converts audio at
the device boundary when the hardware runs at a different rate.
