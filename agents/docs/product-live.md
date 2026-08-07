# Live performance product contract

This document defines the user, supported task, failure behavior, and release
evidence for the Current roadmap milestone. It is a product contract: an
implementation is incomplete when it exposes the necessary controls but does
not let the user finish this task safely.

## Target user and task

The primary user is a singer-songwriter or livestream performer who already
understands a conventional DAW. The reference setup has:

- one microphone input;
- one instrument input;
- one or more MIDI controllers for instruments, transport, and Mixer control;
- prepared audio or MIDI accompaniment stored in the project;
- a Heron Mixer graph with channels, buses, outputs, sends, and plug-ins; and
- one hardware output feeding speakers or a hardware loopback used by streaming
  software.

Direct integration with streaming applications is not required. A hardware
interface may provide the loopback route. New recording workflows are not part
of Current, but existing recording, recovery, and prepared-track playback must
not regress.

## Canonical journey

The 30-minute usability task starts from an installed application and ends with
a stable monitored performance:

1. Create or open a project.
2. Select the supported audio backend, input device, output device, buffer, and
   microphone/instrument channels.
3. Confirm that input reaches the intended Mixer channels without feedback or
   an ambiguous route.
4. Connect MIDI controllers and route notes to the intended Instrument tracks.
5. Load instruments and effects, build buses and sends, and choose the monitored
   Output.
6. Configure low-latency mode and understand which plug-ins are bypassed or add
   unavoidable latency.
7. Map hardware controls to transport, ordered Mixer targets, and named plug-in
   parameters.
8. Import or reuse project audio/MIDI assets as accompaniment.
9. Start playback or live monitoring and verify output, meters, latency, and
   health state.
10. Recover from a device loss without letting a stale background reconnect
    override the user's choice.
11. Continue for at least two hours and finish with the project and mappings in
    a known saved state.

The task may use in-product labels, descriptions, and recovery guidance. It may
not require source code, developer documentation, or a Heron-specific tutorial
to discover ordinary DAW operations.

## External control model

### Persistence

Controller mappings are application preferences, not project rows. The input
address contains the physical MIDI device ID plus channel, message kind, and
controller or note number. Disconnecting a device does not delete its mappings.

Project-owned targets resolve at use time:

- A Mixer target is an index into the current shared Mixer order. Audio,
  Instrument, BUS, Output, and Master channels participate in that order.
- A plug-in target is a project-unique `controlAlias` plus a stable parameter
  key. Display names may repeat and are not control addresses.

Reordering Mixer channels intentionally retargets index-based mappings. A
missing index or alias consumes no mutation and produces no modal interruption.
The implementation must never fall through to an arbitrary target.

### Current targets

Current includes Gain, Pan, Mute, and Solo for ordered Mixer channels and an
arbitrary automatable parameter for an aliased plug-in instance. Mute and Solo
bindings choose between toggle behavior and absolute `0 = off, nonzero = on`
behavior.

Current excludes Send targets, control-surface protocols, bank switching,
soft takeover, motorized-fader feedback, LED rings, and controller displays.

## Failure contract

| Event                      | User-visible behavior                                                                          | System behavior                                                                                             | Forbidden behavior                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Audio device disappears    | Open an immediate recovery decision that lists usable devices and keeps system status visible. | Continue bounded attempts to recover the previous device until a newer user choice commits.                 | Silently switching to a different device or letting an old attempt overwrite the chosen device.                      |
| MIDI controller disappears | Show disconnected state where the route or settings are inspected.                             | Retain mappings by device ID and resume them when that ID returns.                                          | Deleting or retargeting mappings.                                                                                    |
| Plug-in cannot load        | Mark the instance unavailable/bypassed and explain the failure at its owning surface.          | Keep legal graph topology and continue unrelated signal paths.                                              | Rejecting the whole project or hiding the failed instance.                                                           |
| CPU pressure or XRUNs      | Escalate status severity and provide details and user-controlled remedies.                     | Continue the committed graph and collect bounded diagnostics.                                               | Automatically increasing the buffer, bypassing a plug-in, or changing routing.                                       |
| Fatal plug-in/native crash | The application may terminate; relaunch offers the existing saved-versus-recoverable choice.   | Preserve every committed project mutation and recovery artifact already guaranteed by the project services. | Pretending a mutation succeeded, reconstructing ambient resources, or introducing plug-in isolation that breaks ARA. |
| Mapping target missing     | No blocking interruption. The mapping remains configured.                                      | Ignore the event without a target mutation.                                                                 | Falling through to a channel or plug-in that happens to occupy another address.                                      |

No fixed relaunch-time service level is promised in Current. Recovery correctness
and an unambiguous user choice are release requirements.

## Device recovery concurrency

Device recovery is a stateful mutation and follows the repository cross-process
contract. Each attempt carries a generation. Opening the decision does not
cancel the bounded attempt for the previous device. When the user commits a new
device, that generation becomes authoritative; completion from an older attempt
is stale and cannot publish state.

If the original device returns before the user commits another choice, playback
may resume. The still-open decision remains meaningful: a later explicit choice
must switch to the selected device even though the original device is working
again.

## Health and interruption policy

Live work distinguishes visibility from interruption:

- continuous state belongs in the status bar;
- active warnings and remedies belong in the status detail panel;
- a newly occurring condition may use a non-modal notification;
- a dialog is reserved for a condition that prevents continuation or requires
  an immediate decision; and
- logs retain developer detail but never substitute for user communication.

Rapid telemetry such as meters is not announced to assistive technology.
Warnings state what is affected, whether audio or project data is safe, and the
next action. Heron does not make creative or latency trade-offs on the user's
behalf.

## Platform and plug-in matrix

All three release platforms must pass before Current exits:

| Platform | Live reference backend           | Required hardware evidence                                                         |
| -------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| Windows  | ASIO with a 64-bit vendor driver | Microphone/instrument input, MIDI, VST3, output, device loss, two-hour run         |
| macOS    | CoreAudio                        | Microphone permission, input/output, MIDI, VST3, output, device loss, two-hour run |
| Linux    | ALSA                             | Input/output, MIDI, VST3 generic or native editor path, device loss, two-hour run  |

VST3 is release-blocking. ARA must not regress but is not itself a Live task.
CLAP work may continue without blocking this milestone. AU, JACK, PipeWire, and
PulseAudio remain backlog items.

## Evidence record

Each release candidate records:

- build identifier, operating system, backend, devices, driver versions, buffer,
  sample rate, and plug-ins;
- the canonical journey result and elapsed setup time;
- a manually started mock-device soak result;
- a real-hardware two-hour session result per platform;
- XRUN count and explanation, peak resource use, and any unbounded trend;
- device-loss recovery behavior; and
- user-test completion time and observed confusion.

The 30-minute result must come from a real target user. Until such a session is
recorded, documentation may say the flow is ready for testing but must not claim
that usability validation passed.
