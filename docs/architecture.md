# Architecture

## Process boundaries

```text
Vue renderer
  ├─ Reka UI / native-engine state projection
  └─ window.yadaw (narrow, typed preload API)
          │ structured-clone IPC
Electron main process
  ├─ @yadaw/audio-host-client (.node IPC transport)
  │       │ ipc-channel
  │       ▼
  │   audio-host
  │     ├─ winit main thread: VST3 controller/editor ownership
  │     ├─ iced/tiny-skia: editor chrome and parameter mode
  │     ├─ cpal callbacks + preallocated parameter/audio queues
  │     └─ dsp-core
  └─ @yadaw/dsp-node (.node offline tools)
```

The `.node` binary is a Node addon, not a browser module. It is loaded in the
Electron main process and deliberately excluded from the renderer bundle.
`contextIsolation` and Chromium sandboxing remain enabled, and the preload only
exposes named, validated operations.

VST3 editor windows are not Electron windows. Clicking a plug-in sends one
typed request through preload and Electron main; `audio-host` creates or focuses
one winit top-level window per instance. The winit main thread also owns the
controller, `IComponentHandler`, `IPlugView`, and `IPlugFrame`. iced draws the
toolbar and generic parameter editor in that same event loop, while a native
plug-in editor is attached to a child HWND, NSView, or X11 XEmbed window below
the toolbar. Wayland falls back to the parameter editor.

Desktop-shell identity remains owned by Electron even though editor windows
live in `audio-host`. Both processes use the stable `dev.yadaw.studio`
application ID. On Windows, Electron passes its main-window HWND through the
native client only at helper bootstrap; winit creates each editor as an owned
window and omits its independent taskbar item. On macOS the helper uses the
Accessory activation policy so it does not create a second Dock application.
On X11 and Wayland the Electron class and winit `WM_CLASS`/application ID use
the same value. The helper never creates a tray icon.

On Windows, the winit main thread initializes OLE before loading any VST3
module and keeps it initialized until every view, controller, component, and
module has been released. This ordering is required because a plug-in may
create COM-backed VSTGUI resources such as its WIC imaging factory from
`InitDll`, before `IPlugView::attached` is called.

## Real-time rule

Electron IPC allocates and copies data. It must not sit in a real-time audio
callback. The renderer is a control surface only: host/device enumeration,
stream ownership, the transport clock, and real-time I/O belong to Rust/cpal.
The native engine uses cpal-owned callback threads and a bounded lock-free SPSC
ring; UI and IPC work stay outside those callbacks. Runtime metrics are exposed
as atomic snapshots rather than callback events.

The stream bridge is primed with one requested block. Input and output callback
timestamps estimate ADC-to-callback and callback-to-DAC latency, while current
ring occupancy supplies the internal bridge contribution. Physical loopback
measurement is still required for authoritative round-trip latency. Input
monitoring remains muted until the audio graph owns that routing decision.

Requested buffer sizes are advisory. Rust keeps a fixed request only when it is
inside the device's reported range; otherwise, or when the backend cannot report
a range, it opens the stream with `BufferSize::Default`. The negotiated
input/output sizes and a fallback flag are returned to the renderer, and the
working output size replaces the stale persisted request.

Applying an unchanged configuration is idempotent. Requests matching either the
original buffer request or the currently negotiated input/output size reuse the
live engine; they do not tear down and immediately reopen WASAPI endpoints.

Preferences do not own the sample rate. Until Project Settings provides the
session rate, the output device's native default is the engine clock. The input
stream keeps its own native rate and an allocation-free adaptive linear
resampler converts it at the ring consumer; ring-fill error supplies a bounded
drift correction for independent clocks. This removes device-switch sample-rate
mismatch failures without introducing a hidden Preferences setting. The linear
stage must be replaced by a band-limited production SRC before input monitoring
or recording is armed.

There is one audio-device namespace. cpal supplies the available hosts, device
names, stable IDs, and defaults. Chromium `MediaDevices` and Web Audio devices
must not be mixed into project settings.

## Mixer channel and hardware routing

Mixer channels and physical device channels are separate concepts:

- The mixer owns a fixed namespace of 256 one-based, mono `BUS` signal slots.
  BUS slots are routing resources, not mixer channels, and are never created or
  deleted with the project.
- `Audio` channels belong to timeline tracks. `Aux` channels are otherwise
  equivalent audio-processing channels without a track. Both select either
  hardware inputs or BUS slots as their input and independently choose mono or
  stereo format. A stereo BUS input consumes an adjacent pair such as BUS 1–2.
- Both main outputs and sends from `Audio`, `Instrument`, and `Aux` channels can
  target either a BUS slot or an `Output`. Routing to a BUS downmixes the stereo
  processing frame into that mono signal slot; routing to an `Output` preserves
  the stereo frame.
- The singleton `Master` is not a routable graph node: it cannot be a main-path
  destination, cannot route onward, and cannot source or receive a send. Its
  gain, pan, mute, and meters form an implicit global final-control stage that
  is applied independently after each `Output` channel's processing.
- `Output` is a stereo sink mapped to two distinct, one-based hardware output
  channels. A project can define multiple outputs, such as speakers on 1–2 and
  headphones on 3–4, and route processing channels to either mix.

`input_source` distinguishes hardware and BUS inputs. `input_format` selects one
input for mono or an adjacent left/right pair for stereo. Mono recordings remain
mono assets on disk, then expand to a stereo frame when they enter the track
processing graph. Everything downstream stays stereo, so a plug-in can produce
different left and right signals without the channel collapsing them back to
mono.

## Dependency direction

```text
desktop -> contracts
desktop renderer -> audio-engine + contracts
desktop main -> dsp-node -> dsp-core
dsp-core -> no JS or Electron dependencies
```

## Near-term milestones

1. Project/session model and undoable command bus.
2. Rust transport clock, audio graph, plugin-delay reporting, and offline rendering.
3. Project sample-rate ownership and a band-limited production asynchronous SRC.
4. Lock-free control commands and richer metering snapshots.
5. Waveform peak cache, file decoding, plugin hosting, and persistence.
