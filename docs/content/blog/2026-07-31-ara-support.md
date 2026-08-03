---
title: The journey to ARA support
date: 2026-07-31
description: Why native Logic Pro on Apple Silicon still cannot host ARA plug-ins — and why the same protocol was surprisingly straightforward to support in Heron.
tags: [ara]
vstTrademark: true
---

# The journey to ARA support

Ever since I moved to Apple Silicon, I have barely used ARA plug-ins in Logic Pro. The only reliable way to load them is to open Logic under Rosetta — and that tax on performance is hard to accept on a machine that is otherwise excellent for music production.

## The workaround treadmill

The usual advice is familiar: freeze the track, bounce in place, or otherwise hand a static audio file to a regular VST® 3 or AU plug-in that can do something similar. Those workflows work until they do not.

Once the audio is frozen or rendered, you lose the interactive loop that made ARA useful in the first place. You cannot freely move the clip, tweak timing, or keep editing against a live analysis model without bouncing again. For tools that are supposed to sit _inside_ the arrangement — Melodyne-style editing, tempo-aware processing, region-level analysis — that is a severe downgrade, not a substitute.

So the question lingered: is ARA somehow intrinsically hard, or is this just a host-specific dead end?

## Worse than Melodyne: Synthesizer V

Melodyne is the example everyone reaches for, but it is not the worst case. Melodyne still starts from audio that already exists. Without ARA you pay in friction — bounce, re-analyze, bounce again — yet the material itself is still there.

Synthesizer V is different. The voice _is_ the instrument. Pitch, timing, lyrics, and especially timbre are not a corrective pass over a finished recording; they are the generative controls that define the performance. Retaking pitch versus timbre, swapping voicebanks, shaping tone against the rest of the mix — all of that only works when the synthesizer stays live and linked to the arrangement.

Lose ARA on native Logic, and the freeze-style escape hatch almost disappears. You are not “re-processing a clip”; you are re-rendering a singer every time the arrangement or the voice moves. Import MIDI into a disconnected instrument plug-in, export audio, drop it back on the timeline, discover the harmony shifted or the timbre no longer fits, and start over. Timbre work becomes the most expensive part of the loop, because it is exactly the part that needs to stay interactive.

Dreamtonics themselves document the gap: AU ARA for Synthesizer V is compatible with Logic only on Intel or under Rosetta, and native Apple Silicon Logic gets neither deep ARA nor ARA Bridge. For a Melodyne user that is annoying. For a Synth V user trying to sculpt a voice inside the mix, it is closer to a hard stop.

## ARA in Heron was surprisingly easy

When we wired ARA into Heron, the surprising part was how little drama there was.

ARA wants a close relationship with the host: shared musical context, random access to audio samples, and bidirectional updates when either side changes the model. That sounds intimidating on paper. In practice, once the host already owns the project timeline, the audio assets, and an in-process VST 3 runtime, the ARA document-controller path fits naturally. There was no need for freeze bridges, out-of-band bounce steps, or a separate “ARA-compatible mode.” The protocol expects the host and the plug-in to share an address space — and in Heron, they do.

That contrast made the Logic situation even more interesting. If ARA itself is not the hard part, what changed on Apple Silicon?

## Out-of-process Audio Units

On Apple Silicon, Logic Pro does not load Audio Units the way it used to under pure x86_64.

When Logic runs natively as arm64, it starts a separate plug-in host process: `AUHostingServiceXPC`. Under the traditional x86_64 / Rosetta launch path, that process typically does not appear. Apple documents this model in [Debugging Out-of-Process Audio Units on Apple Silicon](https://developer.apple.com/documentation/audiotoolbox/debugging-out-of-process-audio-units-on-apple-silicon): beginning with macOS 11, the system can load audio units into a separate process depending on architecture and host preference.

That design has clear upsides:

- **Mixed architectures.** The same Logic session can talk to more than one hosting service — commonly one for native arm64 plug-ins and another (`AUHostingServiceXPC_arrow`) that runs x86_64 plug-ins under Rosetta. One host, both plugin worlds.
- **Isolation.** Logic and the plug-in host communicate over IPC/XPC. Separate address spaces mean a crashing or malicious plug-in is much less able to scan the project for sensitive data or hook Logic’s own process.

For ordinary Audio Units that exchange audio buffers and parameter messages across that boundary, the model works well. ARA is not an ordinary Audio Unit relationship.

## Why ARA breaks across the process boundary

ARA’s bidirectional design assumes the plug-in can reach into host memory. The host hands over pointers so the ARA plug-in can randomly read — and in some flows, write — sample data and related structures without copying every access through a narrow IPC channel.

That assumption collapses as soon as the host and the plug-in live in different processes.

On a modern OS, each process has its own virtual address space and permission checks. A pointer that is valid inside Logic is meaningless inside `AUHostingServiceXPC`. There is no safe, general way to treat “this `float*` from the DAW” as a readable region in the plug-in host. The security benefits of out-of-process hosting — the same benefits that let Logic mix arm64 and x86_64 plug-ins — are exactly what make ARA’s shared-memory contract illegal.

So the failure mode is not “Apple Silicon cannot run Melodyne.” It is more structural than that: **native Logic chooses process isolation for Audio Units; ARA historically requires shared address space; those two requirements conflict.**

## An unsatisfying, but honest, conclusion

Until one of the following changes, this looks unsolvable in the current Logic + Apple Silicon arrangement:

1. macOS fully retires Rosetta and drops the need to keep x86_64 plug-ins coexisting with arm64 ones in the same session, _and_ hosts are willing to load ARA plug-ins in-process again; or
2. Logic (and the system hosting stack) give up simultaneous cross-architecture plug-in loading in favor of an in-process path that ARA can use; or
3. the ARA / Audio Unit stack grows a true out-of-process replacement for pointer-based random access — something that does not exist as a drop-in today.

None of those are under a third-party host’s control. Heron can support ARA because it hosts compatible plug-ins in-process and can honor the memory model the protocol still assumes. Logic’s native Apple Silicon path optimized for a different set of constraints — stability, security, and architecture mixing — and ARA fell through the crack between them.

That is why, years after the M1, opening Logic under Rosetta still feels like the only honest answer for ARA — and why implementing ARA in a host that never made that tradeoff felt unexpectedly straightforward.
