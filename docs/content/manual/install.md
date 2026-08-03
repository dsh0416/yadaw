---
title: Install Heron
description: Download and start Heron on Windows, macOS, or Linux.
vstTrademark: true
asioTrademark: true
---

# Install Heron

Heron publishes installers for Windows, macOS, and Linux with each tagged
release.

## Download a release

1. Open [Heron Releases](https://github.com/minori-live/heron/releases).
2. Choose the newest release and expand **Assets**.
3. Download the file for your system:
   - **Windows x64:** `.exe`
   - **macOS Apple silicon or Intel:** universal `.dmg`
   - **Linux x64 or arm64:** `.AppImage`
4. Keep the accompanying `SHA256SUMS` file if you want to verify the download.

::: tip No release listed?
Heron is experimental. If the Releases page has no published installer yet,
you can build it from source by following the
[development environment guide](https://github.com/minori-live/heron/blob/main/agents/docs/environment.md).
That process is intended for contributors.
:::

## Windows

Run the downloaded installer. Windows audio builds include ASIO® support. For
low-latency work, install the 64-bit ASIO driver supplied by your audio-interface
manufacturer before opening Heron.

If Windows warns about an unrecognized application, confirm that the download
came from the official repository and verify its checksum before continuing.

## macOS

Open the `.dmg` and move Heron to Applications. The first launch may require
confirmation in **System Settings → Privacy & Security**, especially for an
experimental or unsigned build.

Allow microphone access when macOS asks; Heron needs that permission to record
from audio inputs.

## Linux

Make the AppImage executable, then run it:

```sh
chmod +x Heron-*.AppImage
./Heron-*.AppImage
```

Your desktop audio configuration determines which devices are available. Make
sure the user running Heron can access the selected device.

## First launch

Heron scans the system and user VST® 3 locations, starts its isolated audio
services, and opens the project workspace. A large plug-in collection can make
the first scan take longer than later launches.

Continue with [Your first project](first-project.md).
