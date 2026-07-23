# Architecture

## Process boundaries

```text
Vue renderer
  ├─ Reka UI / native-engine state projection
  └─ window.yadaw (narrow, typed preload API)
          │ structured-clone IPC
Electron main process
  └─ @yadaw/dsp-node (.node addon)
          │ napi-rs
Rust audio service
  ├─ cpal host + stable device IDs
  ├─ cpal input callback → preallocated SPSC ring → output callback
  ├─ callback timestamps + atomic latency/xrun telemetry
  └─ dsp-core
```

The `.node` binary is a Node addon, not a browser module. It is loaded in the
Electron main process and deliberately excluded from the renderer bundle.
`contextIsolation` and Chromium sandboxing remain enabled, and the preload only
exposes named, validated operations.

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
