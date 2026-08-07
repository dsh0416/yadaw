---
title: Mixer and routing
description: Balance channels, choose inputs and outputs, and create buses and sends.
vstTrademark: true
---

# Mixer and routing

Open **Mixer** from the top bar to see every audio, instrument, aux, output, and
master channel in the project.

<RoutingPlayground />

## Read a channel strip

Each strip follows the signal from top to bottom:

1. **Input** — hardware input, bus input, or VST® 3 instrument.
2. **Audio FX** — ordered VST 3 effect inserts.
3. **Sends** — copies of the signal routed elsewhere.
4. **Output** — a bus or hardware output destination.
5. **Pan** and **Volume** — channel placement and final level.

The strip also provides record enable where applicable, input monitoring, mute,
solo, a level meter, and a channel menu.

## Choose an input

Audio channels can receive:

- a mono hardware input;
- an adjacent linked stereo pair;
- a bus.

Instrument channels receive the output of their assigned VST 3 instrument.
Auxes normally receive audio through a bus or sends.

## Route to an output

Use the **Output** section to choose the next bus or a hardware-output channel.
Hardware outputs map their left and right sides to channels exposed by the
active output device.

Avoid creating routes that feed a signal back into itself. Heron keeps the
audio graph legal and rejects invalid topology.

## Add a send

Select an empty send slot, then choose:

- the destination bus or output;
- **Pre**, **Post**, or **Pan** tap position;
- send level;
- enabled or disabled state.

Use pre-fader sends for an independent monitor or effect level. Use post-fader
sends when the send should follow channel volume.

## Buses and aux channels

An aux channel provides a place to process a shared return or submix. Route
channels or sends to its bus, add effects on the aux, then route the aux onward
to the master path or a hardware output.

## Metering

Keep channel and master peaks below clipping. The meters transition from green
through yellow to red as headroom runs out. Lower the source, plug-in output, or
channel level when a stage clips; lowering only the final master may leave an
earlier stage overloaded.

## Bounce an Output

Each hardware Output strip has a **Bnc** button in its input-control row. Use it
to export exactly the signal feeding that Output without changing the project.
Choose WAV, FLAC, or MP3, then set the sample rate, stereo or mono output,
encoding quality, normalization, and bar range.

The start and end bars are both included and bar numbers start at 1. For
example, bars 3–8 begin at the bar line for bar 3 and stop at the bar line after
bar 8. Mono exports combine left and right at −6 dB per channel.

**Overload protection** is the default: it lowers audio only when the sample
peak exceeds 0 dBFS and never raises quiet audio. **True peak** normalization
can raise or lower the result to a target from −12 to 0 dBTP; its default is
−1 dBTP. Integer WAV and FLAC exports can apply TPDF dither.

Use **Include plug-in tails** to choose whether effects may decay beyond the
selected end bar. It is enabled by default. When disabled, the export ends
exactly at the bar line after the selected end bar.

Bounce is exclusive and faster than real time. Heron stops playback, disables
hardware/application monitoring and the metronome, and restores the playhead
and real-time engine afterward without resuming playback. When tails are
included, unknown or infinite tails end after two continuous seconds below
−90 dBFS and are capped at 30 seconds. You can cancel from the operation
progress dialog; a cancelled or failed bounce leaves any existing destination
file unchanged.
