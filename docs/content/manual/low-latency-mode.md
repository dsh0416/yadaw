---
title: Low Latency Mode
description: Prioritize one live monitoring Output while keeping every Output active.
---

# Low Latency Mode

Low Latency Mode reduces the plug-in and delay-compensation latency on the path
you hear while performing. It optimizes one logical Output at a time without
muting, disabling, or rerouting the other Outputs.

It is a session aid rather than a project edit. Its enabled state and target are
not written into the project, do not make the project dirty, and reset when you
close or reopen the project.

## Choose the monitoring Output

When a project opens, Heron selects the first logical Output as the default
target. This is normally **Output 1–2**, but it may be another Output if the
project uses a different ordering.

To use a different destination:

1. Stop the transport.
2. Open the Mixer and find the required Output strip.
3. Select **Set as Low Latency Mode monitoring target**.
4. Select **Low Latency Mode** in the top bar.

Only one Output can be the target. Every Output continues to produce its normal
signal; optimization applies only to monitored main routes that reach the
selected Output.

You can enable or disable the mode, change its target, or change its plug-in
budget only while the transport is stopped. Once enabled, it remains active
during playback and recording.

## Which paths are optimized

Heron discovers monitoring sources from the track controls. You do not need to
mark a channel separately.

A path is eligible when it carries:

- effective audio input monitoring from a configured hardware input; or
- live MIDI monitoring through an instrument.

Record enable by itself does not create a monitoring path. A record-enabled
track with monitoring off is recorded normally but is not optimized.

Heron follows the source's dry main route through shared buses and the target
Output. Sends remain on normal compensation, so a wet return can arrive later
than the dry monitored signal. A late side-chain signal also does not delay the
monitored main input. Other Outputs and unrelated playback branches retain
normal plug-in delay compensation.

## Plug-in latency budget

Open **Settings → Audio → Recording** to set the **Low-latency plug-in budget**.
The default is 5 ms, and the available range is 0–50 ms in whole milliseconds.
Heron converts this value to samples using the current project sample rate.

The budget counts declared plug-in latency along each eligible main path. If a
path exceeds the budget, Heron temporarily bypasses eligible effects, starting
with the largest latency contribution, and recalculates the paths after each
choice.

Instrument plug-ins are never bypassed. Their latency is reported as
unavoidable, and the mode still activates even when that latency alone exceeds
the budget. Effects on tracks, shared buses, and the target Output can all be
temporary bypass candidates.

Temporary low-latency bypass is separate from a plug-in's own bypass or enabled
state. It does not edit the project and disappears when Low Latency Mode is
disabled. Unlike ordinary latency-preserving bypass, this temporary bypass uses
a direct zero-latency pass-through.

## Read the status

The top-bar tooltip shows the target Output, budget, and number of temporarily
bypassed plug-ins. If the mode is enabled but no eligible source currently
reaches the target, it reports **no active monitoring path**. This is a valid
state, not an error.

The Effect Chain Graph marks latency-sensitive paths and effects temporarily
bypassed by Low Latency Mode. It also exposes unavoidable instrument latency.

## What the mode does not reduce

Low Latency Mode changes only the audio graph. It does not change:

- the audio-device buffer size;
- ADC or DAC conversion time;
- input-ring buffering;
- sample-rate conversion latency; or
- the project or device sample rate.

For the lowest practical round-trip latency, use Low Latency Mode together with
a stable, appropriately small device buffer. If you hear XRUNs or dropouts,
increase the buffer even if that adds some hardware latency.

Because the monitored path takes priority over playback alignment, a monitored
track and any shared bus it joins may temporarily lose strict PDC alignment with
the rest of the arrangement. This is expected. Disable Low Latency Mode when you
want to judge final timing, effects, and mix balance with full compensation.

## Session behavior

- Restarting the isolated audio helper keeps the current session policy.
- Closing, switching, or reopening a project disables the mode.
- The plug-in budget is an application setting and remains available across
  projects and application restarts.
- If the target Output is deleted, the mode turns off and Heron selects the
  first remaining Output as the new default target.
