---
title: VST® 3 plug-ins
description: Discover, add, configure, and troubleshoot VST 3 instruments and effects.
vstTrademark: true
---

# VST® 3 plug-ins

YADAW discovers VST 3 instruments and effects from standard system and user
locations. Plug-ins run through an isolated audio-host process so a failed
module can be reported and quarantined without loading native code directly
into the interface.

Audio Unit, CLAP, VST 2, and AAX plug-ins are not currently scanned. See
[Supported backends and plug-in formats](supported-backends.md) for the full
platform matrix and planned formats.

## Scan the catalog

YADAW scans on startup. To look again after installing a plug-in:

1. open **Library**;
2. choose the plug-in catalog;
3. select **Rescan VST3**.

The startup and scan views report discovered bundles, available plug-ins, and
modules that could not be loaded.

## Add an instrument

Add an instrument channel, then select its **Instrument** input slot. Search by
name or vendor and choose the plug-in.

If the instrument supports more than one layout, choose its audio mode before
loading it. Instrument modes include mono and stereo output.

## Add an effect

On any compatible mixer channel:

1. select an empty slot under **Audio FX**;
2. search the VST 3 effect catalog;
3. choose a supported mode;
4. select the loaded insert to open its editor.

Effects may support mono, stereo, mono-to-stereo, or dual-mono layouts. An
unsupported mode remains unavailable in the picker.

## Manage inserts

An insert can be:

- opened in its native editor;
- bypassed and enabled again;
- moved to another slot;
- removed;
- switched to another supported audio mode.

Changing or removing a plug-in is part of project history where the operation
supports undo.

## Route a side-chain input

When a VST3 instrument or effect exposes a mono or stereo auxiliary audio input,
its native editor toolbar shows **Side-chain**. Open it, choose the auxiliary
input bus, then select **Audio**, **Instrument**, or **Aux** and a source
channel. Choose **None** to disconnect that bus. Each auxiliary input is routed
independently.

The source is the channel's post-pan signal: its plug-in chain, fader, mute,
solo, and pan all affect the side-chain. Hardware inputs and internal BUS slots
cannot be selected directly. Master, Output, the plug-in's own channel, and any
source that would create feedback are excluded.

The old selection remains active while the project change is pending. A failed
change leaves it untouched and displays a warning. If the project was saved but
the audio graph could not be deployed completely, the new selection remains
the project value and the editor reports the degraded audio state.

## Missing or failed plug-ins

The project keeps a legal signal path when a stored plug-in is missing,
quarantined, or fails to start. Check the slot state and catalog status, then:

1. confirm that the correct plug-in and architecture are installed;
2. rescan the catalog;
3. restart YADAW if the plug-in was installed while the host was active;
4. bypass or remove a plug-in that repeatedly fails.

Never assume two plug-ins with similar names or vendors are interchangeable;
their identifiers and saved state may differ.
