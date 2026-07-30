---
title: Mixer and routing
description: Balance channels, choose inputs and outputs, and create buses and sends.
---

# Mixer and routing

Open **Mixer** from the top bar to see every audio, instrument, aux, output, and
master channel in the project.

## Read a channel strip

Each strip follows the signal from top to bottom:

1. **Input** — hardware input, bus input, or VST3 instrument.
2. **Audio FX** — ordered VST3 effect inserts.
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

Instrument channels receive the output of their assigned VST3 instrument.
Auxes normally receive audio through a bus or sends.

## Route to an output

Use the **Output** section to choose the next bus or a hardware-output channel.
Hardware outputs map their left and right sides to channels exposed by the
active output device.

Avoid creating routes that feed a signal back into itself. YADAW keeps the
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
