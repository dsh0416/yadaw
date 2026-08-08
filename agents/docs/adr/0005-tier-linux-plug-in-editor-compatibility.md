# ADR-0005: Tier Linux plug-in editor compatibility

- Status: Proposed
- Date: 2026-08-09
- Owners: project maintainers
- Related: `agents/docs/native-call-boundary.md`,
  `agents/docs/roadmap.md`,
  [VST 3.8 Wayland support](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/Change%2BHistory/3.8.0/IWaylandHost.html),
  [VST platform UI types](https://steinbergmedia.github.io/vst3_doc/base/group__platformUIType.html),
  [Wayland core protocol](https://wayland.freedesktop.org/docs/html/apa.html),
  [Electron `BrowserWindow`](https://www.electronjs.org/docs/latest/api/browser-window)

## Context

Heron's Linux VST3 editor path currently gives a plug-in an X11 child window
that supports XEmbed. This works when Electron runs through X11 or XWayland.
It does not work when Electron runs as a native Wayland client, so Heron
rejects the native editor and falls back to its generic parameter editor.

Wayland does support `wl_subsurface`, but it does not expose an X11-style,
globally reparentable window ID. A `wl_surface` is a protocol object scoped to
one compositor connection. A host therefore cannot take an independently
created third-party top-level surface and reparent it into an Electron window.

VST 3.8 defines `kPlatformTypeWaylandSurfaceID` and `IWaylandHost` to solve this
for conforming plug-ins. The host acts as a nested Wayland compositor, gives
the plug-in a host-owned connection, and lets the plug-in create a surface that
the host attaches as a subsurface. This is substantially different from
XEmbed. It adds compositor, input, focus, popup, scaling, graphics, and teardown
responsibilities to the DAW, while existing Linux plug-ins may continue to
support only `kPlatformTypeX11EmbedWindowID`.

Electron's public Linux native-window API documents an X11 `Window`, not a
stable Wayland surface and connection contract suitable for VST 3.8. Depending
on Chromium/Ozone implementation objects would create an unsupported ABI and
lifetime dependency. Choosing a compatibility policy is therefore a durable
platform commitment, not an interchangeable windowing implementation detail.

## Decision

Heron uses three explicit Linux editor capability tiers.

1. **X11 or XWayland native editor.** When Electron exposes a valid X11 parent,
   Heron attaches the VST3 view through `kPlatformTypeX11EmbedWindowID` and
   XEmbed. This is the release path for third-party native editor compatibility
   until the native Wayland tier satisfies its acceptance evidence.
2. **Native Wayland editor.** Heron may offer this tier only through the VST 3.8
   `kPlatformTypeWaylandSurfaceID` and `IWaylandHost` contract. The plug-in must
   opt into that platform type and create its surface through a per-editor
   host-owned Wayland connection. Heron must not reinterpret a `wl_surface` as
   a global window handle, reparent an independently connected surface, or use
   private Chromium/Ozone symbols as a compatibility ABI.
3. **Generic parameter editor.** This is the required recoverable fallback when
   the active display backend has no accepted native path, the plug-in does not
   support the matching platform type, or native attachment fails before
   commit. Audio processing, state, and parameter control remain available.

Until tier 2 meets the verification below, Linux builds that advertise broad
third-party native editor support use X11/XWayland as the preferred application
backend when it is available. Native Wayland remains a supported application
mode with an explicitly narrower plug-in-editor capability. Heron does not
silently relaunch or switch display backends after a project has opened; users
may deliberately choose the native Wayland mode or the documented XWayland
compatibility mode at application launch.

The native Wayland implementation must preserve ADR-0001 and the existing
editor ownership boundary:

- Electron main owns the editor request, top-level lifetime, toolbar, and
  platform application loop.
- The embedded native runtime owns the VST3 view, the per-editor Wayland server
  state, and deterministic attach/detach cleanup.
- Wayland protocol work is integrated into the existing bounded main-thread UI
  drain. It must not create or pump a second platform application loop.
- No audio or plug-in GUI helper process, OS shared-memory transport, watchdog,
  or restart coordinator is introduced.
- The renderer sees only a typed editor capability/result through
  `window.heron`; it never receives a native surface, display connection, or
  plug-in ABI object.

Native Wayland support is not complete merely because a parent `wl_surface`
pointer can be obtained. It becomes supported only when a stable integration
owned by the repository can place the plug-in below the host toolbar without
private Electron ABI access and the complete acceptance matrix passes.

## Alternatives rejected

### Treat `wl_surface` like an X11 child-window handle

This ignores connection-scoped Wayland object identity and surface roles. It
cannot safely reparent a surface created on an unrelated plug-in connection.

### Depend on Chromium/Ozone private Wayland objects

This could expose Electron's current internal surface and connection, but those
objects are not a supported Electron API. Their ownership, threading, and
lifetime may change with any Electron or Chromium update.

### Float legacy X11 editor windows over a native Wayland application

Independent XWayland top-level windows avoid subsurface integration but do not
provide an embedded editor. Position, stacking, focus, resize, modal popup, and
close behavior would vary by compositor and would not satisfy the host-owned
editor contract.

### Add an editor or plug-in helper process

A helper could own another display connection or compositor, but it would add
process supervision and native-window reconciliation that conflict with the
embedded runtime decision in ADR-0001. GUI isolation alone would not isolate
the in-process plug-in processor or ARA ownership.

### Support only the generic parameter editor on Linux

This is a safe fallback but not an acceptable long-term substitute for the
custom editors on which many instruments and effects depend.

### Force XWayland permanently

This maximizes compatibility with existing plug-ins but prevents Heron from
adopting the standardized VST 3.8 Wayland path as the ecosystem matures.

## Consequences

- Linux support claims distinguish audio/parameter support from native-editor
  support and name the active display-backend constraint.
- X11/XWayland remains part of the Linux compatibility matrix even after a
  native Wayland implementation lands because third-party adoption is per
  plug-in.
- A pure Wayland user may receive the generic editor for an otherwise fully
  functional VST3 plug-in.
- Implementing tier 2 requires a repository-owned nested compositor boundary
  and substantial tests for input, focus, popups, scale, rendering, resize, and
  teardown. Receiving a surface pointer alone is insufficient.
- Native attachment failure must leave one deterministic outcome: the native
  view is detached, host compositor resources are closed, and the generic
  editor remains available. It must not leave an orphan surface or ambiguous
  editor-open state.
- Public documentation and diagnostics must make the selected backend and
  fallback visible rather than presenting all Linux native editors as equally
  supported.

## Verification

The accepted implementation and release matrix must include:

- the existing official VST3 fixture editor smoke test on X11/XWayland;
- native Wayland fixture coverage for capability negotiation, the host-owned
  connection, subsurface attach, pointer and keyboard input, focus, resize,
  scale changes, popups, and close ordering;
- a VST3 fixture that supports only X11 and proves a native Wayland session
  reaches the generic editor without a crash, orphan window, or leaked server
  resource;
- repeated open, failed-attach, fallback, close, and application-shutdown
  cycles under a headless Wayland compositor;
- architecture inspection proving there is no helper executable, private
  Chromium/Ozone linkage, renderer-native handle, second platform loop, or GUI
  work on the audio callback; and
- English and Chinese user documentation that states the X11/XWayland, native
  Wayland, and generic-editor behavior consistently.

Until all native Wayland evidence exists, Linux release evidence for custom
third-party editors is collected on X11/XWayland, while native Wayland evidence
proves the generic fallback and normal audio operation.

## Reconsider when

Replace this ADR if Electron publishes a stable embeddable Wayland surface and
connection API that changes ownership, if a later VST revision replaces
`IWaylandHost`, if measured plug-in adoption makes XWayland unnecessary, or if
a superseding process-isolation decision provides a complete GUI and ARA
ownership model.
