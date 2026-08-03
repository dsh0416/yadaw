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

## Missing or failed plug-ins

The project keeps a legal signal path when a stored plug-in is missing,
quarantined, or fails to start. Check the slot state and catalog status, then:

1. confirm that the correct plug-in and architecture are installed;
2. rescan the catalog;
3. restart YADAW if the plug-in was installed while the host was active;
4. bypass or remove a plug-in that repeatedly fails.

Never assume two plug-ins with similar names or vendors are interchangeable;
their identifiers and saved state may differ.
