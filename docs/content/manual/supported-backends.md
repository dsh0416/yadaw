---
title: Supported backends and plug-in formats
description: Check which audio backends and plug-in formats Heron supports on each operating system.
vstTrademark: true
asioTrademark: true
---

# Supported backends and plug-in formats

Heron uses the word **backend** for the connection between its audio engine and
an operating-system audio driver. A plug-in format, such as VST 3 or Audio Unit,
is a separate compatibility layer for instruments and effects.

This page describes the current development version. A backend can be included
in Heron but still appear unavailable when its driver or device cannot be
opened.

## Audio backends

<AudioBackendSupportFigure />

**Supported** means the backend is included today. **Planned** means it is on
the roadmap but is not yet included or selectable. A dash means the backend is
not intended for that operating system.

| Backend    | Windows   | macOS     | Linux     | Notes                                                                                |
| ---------- | --------- | --------- | --------- | ------------------------------------------------------------------------------------ |
| WASAPI     | Supported | —         | —         | Uses the audio devices provided by Windows.                                          |
| ASIO®      | Supported | —         | —         | Requires a 64-bit ASIO driver. Input and output must use the same ASIO driver.       |
| CoreAudio  | —         | Supported | —         | Recording requires microphone permission from macOS.                                 |
| ALSA       | —         | —         | Supported | Device access and availability depend on the system's ALSA configuration.            |
| JACK       | Planned   | Planned   | Planned   | A dedicated JACK backend is planned on all three platforms.                          |
| PipeWire   | —         | —         | Planned   | Native PipeWire integration will be added in a future version.                       |
| PulseAudio | —         | —         | Planned   | A dedicated PulseAudio backend will be added in a future version.                    |
| Mock       | Supported | Supported | Supported | Runs the engine without audio hardware. Capture is silent and playback is discarded. |

Until the dedicated JACK, PipeWire, and PulseAudio backends arrive, a Linux
device may still appear through ALSA when the system provides a compatible
bridge.

The backend selector only shows backends included in the running build and
enables those available on the machine; planned backends do not appear yet.
**Mock** is always available and is listed last as a fallback. See
[Settings and audio devices](settings.md) to choose a backend, devices, and
buffer size.

### Choosing a Windows backend

Start with WASAPI when using ordinary Windows audio devices. For a dedicated
audio interface, its manufacturer's ASIO driver will usually provide the most
direct low-latency path. Do not substitute a driver from an unrelated device.

ASIO presents one driver as the input and output device. Heron therefore cannot
combine the input of one ASIO driver with the output of another. WASAPI,
CoreAudio, and ALSA can select input and output devices independently; Heron
uses adaptive resampling and drift correction when their clocks differ.

## Plug-in and audio-unit formats

| Format           | Operating systems     | Status        | Notes                                                                                                                 |
| ---------------- | --------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| VST® 3           | Windows, macOS, Linux | Supported     | Instruments, effects, saved state, and editor windows are supported.                                                  |
| VST 3 with ARA 2 | Windows, macOS, Linux | Supported     | Available when a VST 3 plug-in exposes an ARA 2 companion. ARA is not scanned as a separate format.                   |
| CLAP             | Windows, macOS, Linux | Planned       | Not scanned or loadable in the current version.                                                                       |
| Audio Unit (AU)  | macOS                 | Planned       | `.component` bundles are not currently scanned or loadable. Use the VST 3 edition of a plug-in when one is available. |
| VST 2 and AAX    | —                     | Not supported | These formats are not scanned or loadable.                                                                            |

The current catalog scans only VST 3 locations and includes Heron's built-in
Gain, Sine, and Metronome processors as VST 3 plug-ins. Installing only the
Audio Unit edition of a product will not make it appear in Heron.

::: tip Linux editor windows
On Linux under Wayland, a plug-in's native VST 3 editor may be unavailable.
Heron can fall back to its generic parameter editor; the native Wayland editor
path is still planned.
:::

For scanning, inserting, and troubleshooting supported plug-ins, see
[VST 3 plug-ins](plugins.md).
