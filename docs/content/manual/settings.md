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

Changing session sample rate changes the project clock. YADAW converts audio at
the device boundary when the hardware runs at a different rate.
