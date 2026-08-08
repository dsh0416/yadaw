# Product interaction design

This specification governs workflow, control placement, feedback, and DAW
interaction semantics. [The design system](design-system.md) governs tokens,
shared primitives, visual states, and accessibility. A screen can satisfy the
design system and still fail this document by hiding a frequent operation,
using an unfamiliar DAW gesture, or leaving a workflow without recovery.

## Behavioral reference

Logic Pro for Mac is Heron's default behavioral reference for Mixer, channel
strip, routing, Send, plug-in slot, and parameter gestures. Heron does not copy
Logic's branding or visual skin; it preserves the expectations a Logic user
brings to an equivalent operation.

When Heron deliberately differs, the product specification names the different
behavior and its reason. A material, lasting departure from the reference that
affects workflow or project semantics requires an ADR. Product-specific
constraints such as cross-platform input, accessibility, and real-time safety
take precedence when documented.

## No-training test

Ordinary DAW operations must be discoverable to a user familiar with another
DAW without source code, developer documentation, or a Heron tutorial. In-product
labels, descriptions, status, and recovery guidance are allowed.

The Current usability metric is completion of the canonical Live task within
30 minutes by a real singer-songwriter or livestream performer. Record elapsed
time, failed attempts, terminology confusion, hidden-control discoveries, and
places where the evaluator expected a direct manipulation but found a menu.
Until a real session passes, do not claim that the flow is usability-validated.

## Control exposure and progressive disclosure

Menus are not storage for controls that the layout has not made room for.

A value or action belongs on the owning surface when at least one is true:

- the user adjusts it repeatedly during the primary task;
- its current value is required to understand signal flow or system state;
- it is time-sensitive during performance;
- comparing it across peer channels or objects is useful; or
- hiding it would violate the Logic mental model.

A menu, popover, or inspector is appropriate when the operation is occasional,
changes configuration rather than a live value, needs explanation or multiple
fields, or is destructive. The direct surface and secondary configuration must
not expose conflicting commit behavior.

Use [the menu specification](menu-design.md) for menu mechanics. Use a popover
for persistent controls and a menu for commands or a terminal choice. Neither
primitive justifies hiding a primary parameter.

## Parameter gestures

Equivalent continuous parameters share a gesture grammar:

- pointer drag changes the value continuously and commits once at gesture end;
- keyboard arrows expose useful fine control and a documented larger step;
- a numeric value remains readable while adjusting;
- double-click restores the defined default;
- preview and commit use the project command/revision contract; and
- cancellation or stale revision never leaves the displayed value pretending
  to be committed.

Wheel adjustment is opt-in for a focused control and must not steal scrolling
from the Mixer or workspace. A specialized knob or fader retains an accessible
name, value, range, and keyboard equivalent.

## Mixer contract

### Channel strips

Audio, Instrument, BUS, Output, and Master strips use one stable vertical
grammar. A section stays aligned across peer strips even when a particular
channel cannot use it. Input, insert, Send, output, pan, fader, meter, Mute, and
Solo states must be readable without opening a generic “more” menu.

Selection, signal flow, enabled/bypassed state, and live warning state are
different concepts and must remain visually and programmatically distinct.
Reordering changes the ordered MIDI-control target by explicit product design;
the UI must make the new order unambiguous.

### Sends

Each populated Send row exposes destination, tap, enabled state, level, and a
directly adjustable level knob. The knob follows the established pan-knob
gesture and value behavior but represents Send level.

Heron follows Logic's Send tap convention:

- **Post Pan** — the knob is on the normal side of the destination and its ring
  is green;
- **Post Fader** — the knob is on the normal side and its ring is blue; and
- **Pre Fader** — the knob moves to the opposite side of the destination and its
  ring is blue.

The compact row does not repeat PRE, POST, or PAN text and does not add a separate
enabled lamp. Knob position carries the tap at a glance, the configuration title
and detailed menu expose it as text, and the whole row's color carries enabled or
disabled state. The official Logic behavior is described in
[Route audio via send effects in Logic Pro](https://support.apple.com/en-ie/guide/logicpro/lgcp8ea0091c/10.7/mac/11.0).

Direct manipulation adjusts level. The secondary menu or popover changes
destination, Pre/Post/Post Pan behavior, enablement, and deletion. Changing tap
or destination remains explicit and undoable; dragging the level control must
not open the configuration surface. A newly created Send starts enabled, and
the destination editor uses the same BUS/Output cascading menu as the empty
Add Send slot.

### Plug-in slots

The slot itself shows the plug-in identity, missing/failed/bypassed state, and
the primary action expected by a DAW user. Opening the editor, bypassing,
replacing, moving, and deleting are distinct commands. A `controlAlias` is a
control-routing identity, not a replacement for the user-facing plug-in name.

## Project asset library

Current is a project asset library, not a disk-wide media manager.

- It shows audio and MIDI assets that belong to the open project.
- Search filters the current project assets.
- Import uses the system file chooser or a supported drag source and commits the
  media into the project before it is treated as a reusable asset.
- Audio may be auditioned after import. Pre-import audition and BPM-synchronized
  preview are deferred.
- MIDI dropped on an empty arrangement area creates an appropriate Instrument
  track and enters the import flow.
- MIDI dropped on an existing Instrument track targets that track.
- The existing import dialog remains available whenever track/sequence mapping
  needs confirmation; users may also invoke it directly.
- An invalid or partially supported file explains whether the project changed
  and offers a next action. It does not leave an empty unexplained asset.

Indexed user folders, tags, favorites, global metadata search, and background
disk scanning are backlog work. Do not add architecture for them to the Current
project-only flow.

## Status, warnings, and interruption

Use the least interruptive layer that still lets the user protect the session:

| Layer                  | Purpose                                                       | Examples                                                         |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Status bar             | Persistent, glanceable health and current state               | Engine state, device, position, XRUN severity                    |
| Status detail panel    | Explanation, impact, and user-controlled remedies             | CPU pressure, latency, sample-rate conversion, repeated XRUNs    |
| Non-modal notification | A newly occurring event worth noticing                        | Controller disconnected, plug-in moved to bypassed failure state |
| Dialog                 | Continuation is impossible or an immediate choice is required | Output device lost and a replacement must be selected            |
| Diagnostic log         | Developer and support evidence                                | Native causes, timing, driver details, bounded counters          |

The same incident may appear in status and a detail panel while a notification
announces its onset. Do not also open a dialog unless the user must decide before
work can continue.

A warning states:

1. the affected object or subsystem;
2. the observable consequence;
3. whether audio and project data are safe;
4. whether Heron changed anything automatically; and
5. the next user-controlled action.

Heron may measure and recommend. It must not automatically increase the buffer,
bypass a high-load plug-in, change routing, or make another creative trade-off
in response to load.

## Device-loss decision

Losing the active audio device is blocking and opens a dialog immediately. The
dialog lists usable replacements while a bounded background attempt continues
for the old device. If the old device recovers, audio may resume, but a later
explicit selection still wins and switches to the selected device.

The dialog remains stable while device results refresh. A device appearing,
disappearing, or reconnecting must not move the focused action or silently
commit a choice. The concurrent state and generation rules live in
[the Live product contract](product-live.md) and
[ADR-0003](adr/0003-device-recovery-precedence.md).

## Review checklist

- The primary action and current signal state are visible on the owning surface.
- Logic behavior is followed or the exception is documented.
- Direct manipulation previews and commits exactly once.
- Menus contain commands/configuration rather than hiding a live parameter.
- Keyboard, focus, accessible value, and pointer behavior agree.
- Status severity does not imply that Heron made an automatic creative choice.
- A failure names the consequence, data safety, and recovery.
- The full journey has a beginning, an observable successful end, and a way out
  of every unavailable or failed state.
