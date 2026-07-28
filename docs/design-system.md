# YADAW Design System

YADAW is a dense professional audio workstation. Its interface should feel precise, calm, and
signal-led: large surfaces remain neutral, while color is reserved for focus, primary action,
feedback, recording, MIDI, audio, meters, and other data-bearing states.

The source of truth is `packages/ui`. Storybook in `apps/design-system` is the interactive
reference. Product screens may compose these primitives, but they must not create a second
generic component system.

## Principles

1. **Signal over decoration.** Color, motion, and elevation explain state or hierarchy.
2. **Dense, not tiny.** Professional density is valuable; illegible text and inaccessible targets
   are not. Generic controls use 32–48 px heights. Specialized DAW controls may use the WCAG
   24×24 px minimum.
3. **Semantic first.** Components consume semantic color, spacing, typography, focus, motion,
   elevation, and layer tokens.
4. **Composition stays in the product.** Views and hosts own stores, routing, and workflows.
   `@yadaw/ui` owns visual behavior and accessibility.
5. **Accessibility is behavior.** Keyboard operation, focus restoration, live regions, reflow,
   contrast, and reduced motion are tested rather than inferred from appearance.

## Package boundary

`@yadaw/ui` may depend on Vue and Reka UI. It must not depend on Pinia, Vue Router, Electron,
`window.yadaw`, IPC contracts, the project database, or product stores. Vue is a peer dependency
to prevent multiple runtimes.

Renderer code imports Reka behavior only through `@yadaw/ui`. A controller host reads stores and
passes serializable props to a presenter. A presenter emits intent; it does not call the preload
API. Storybook product examples render from plain fixtures.

## Tokens

`tokens.css` defines:

- dark and light primitive palettes;
- canvas, surface, text, border, action, feedback, and signal semantics;
- spacing, radius, control size, typography, elevation, focus, motion, and z-index;
- compatibility aliases used by existing DAW styles during source-level migration.

`domain-palette.css` contains fixed product-rendering colors moved out of component styles during
the 61-file audit. These values are allowed only where a DAW visualization needs a stable
spatial or signal distinction: mixer chrome, tracks, clips, waveforms, meters, and plug-in state.
Ordinary forms, overlays, loading states, settings, and navigation use semantic tokens.

Raw colors and numeric z-index values are forbidden outside token sources. Ordinary UI shadows
use the elevation or focus tokens. Domain visualizations may compose a local glow from a semantic
or runtime signal color; this exception is checked and documented by `lint:design`.

Runtime track, waveform, peak, and lane colors must enter through a documented CSS custom
property. Never interpolate a runtime value into a CSS selector or use it as the only carrier of
state.

## Component selection

### Provider

Use `UiProvider` once at the application boundary. It owns text direction, tooltip timing, and
the Reka configuration context. Storybook creates a fresh Pinia per story and wraps every story
with the same provider.

### Actions

- `UiButton` is the default text action. Use `primary` once per decision area, `secondary` for
  normal actions, `ghost` for low-emphasis chrome, and `danger` for destructive commitment.
- `UiIconButton` requires a non-empty `label`. The tooltip supplements, but never replaces, the
  accessible name.
- Loading disables the action, exposes `aria-busy`, and retains the original label so layout and
  intent do not jump.

### Forms

Use `UiField` to associate label, description, error, and required state. Controls use typed
`defineModel`: `UiTextInput`, `UiSelect`, `UiCheckbox`, `UiRadioGroup`, and `UiSlider`.

Validation errors are specific, placed beside the field, and connected with
`aria-describedby`. Do not validate on every keystroke when the user cannot yet provide a
complete value. Disabled controls remain named.

### Overlays

- `UiDialog` owns portal placement, overlay, focus trapping and restoration, Escape, outside
  dismissal, reflow, and modal behavior.
- `UiAlertDialog` is only for a decision that interrupts the workflow. Destructive actions name
  the object and consequence.
- Dialog hierarchy is always eyebrow (optional category), short stable action title, contextual
  description, then body content. File names, project names, plug-in names, paths, counts, and
  changing progress phases do not become the dialog title.
- A body section that names the current phase or result uses a real heading at normal reading
  size. Eyebrows label categories or states; they never substitute for the content heading.
- `UiPopover` contains non-modal contextual controls. It is not a small dialog.
- `UiTooltip` contains short supplemental text and optional shortcut notation. It cannot contain
  an essential action.

Product hosts may own queues or stores, but must render these overlay components. Manual
`Teleport`, hand-written modal backdrops, and local overlay z-indexes are forbidden.

### Feedback

- `UiProgress` uses a value for determinate work and `null` for indeterminate work.
- `UiSpinner` is for compact, unknown-duration work.
- `UiLoadingState`, `UiEmptyState`, and `UiStatusNotice` provide complete page or region states.
- Use `aria-live="polite"` for useful asynchronous status. Use an alert only when immediate
  interruption is necessary. Never announce rapidly changing meters.

### Structure

`UiSurface` and `UiSectionHeading` create stable visual hierarchy without business behavior.
They should remain inexpensive to nest and must not read application state.

## Product patterns

### Loading and long-running operations

Keep the operation title stable, describe the current phase, show determinate progress when
known, and expose cancellation only when the operation is actually cancellable. A completed or
failed operation may be dismissed; a non-cancellable running operation may not.

### Empty and error states

An empty state explains what is absent and offers the most likely next action. An error explains
what failed, whether data is safe, and a recovery action. Avoid error codes as the primary copy.

### Destructive confirmation

The title names the action (“Delete channel?”). The description names the object and states the
irreversible consequence. The destructive button repeats the verb; the safe action is plainly
“Cancel”.

### Two-dimensional workspaces

Arrangement and mixer canvases may scroll locally in two dimensions. Their heading, description,
toolbars, context controls, and overlays still reflow at 320 CSS px and remain operable at 200%
text zoom. Scrolling the canvas must not hide the only way to leave or configure it.

## Content

Use sentence case. Prefer a concrete verb (“Import four tracks”) to a generic label (“OK”).
Status copy states the object and outcome. Short labels may use DAW-standard terms such as dB,
BPM, MIDI, ASIO, and VST3; unfamiliar technical details belong in supporting text.

## Accessibility

WCAG 2.2 AA is the release floor:

- visible focus for every operable element;
- programmatic name, role, value, and state;
- at least 24×24 CSS px targets for dense specialized controls;
- text and UI contrast that meets AA in dark and light themes;
- full keyboard operation without a pointer-only gesture;
- focus trap and restoration for modal overlays;
- 320 CSS px reflow for non-canvas content and 200% text zoom;
- reduced-motion support;
- no information conveyed by color alone.

Every Storybook story runs Axe with `parameters.a11y.test = "error"`. Complex behavior also has a
`play` test. Critical dark/light product examples are the review surfaces for visual snapshots.

## Storybook

Run:

```sh
mise exec -- pnpm design:dev
mise exec -- pnpm design:build
mise exec -- pnpm design:test
mise exec -- pnpm lint:design
```

Storybook is local and CI-only. It is never deployed and is not included in Electron packaging.
Stories are CSF TypeScript. Principles and foundations are MDX. Autodocs provides API reference;
hand-written stories still explain behavior, boundaries, failure states, long text, keyboard
interaction, and dark/light themes.

The toolbar disables motion by default for deterministic screenshots. Choose **Motion enabled**
only for a motion-specific review.

Pixel-based visual snapshots are temporarily skipped in CI while the design system uses
platform-dependent system fonts. Run them locally with `mise exec -- pnpm design:test`. Re-enable
the CI snapshot comparisons after the interface fonts are bundled for deterministic rendering.
Storybook browser tests plus the controls and reflow Playwright tests remain enabled in CI.

## Contribution checklist

- Choose an existing primitive before creating a new generic component.
- Keep stores, routing, contracts, and preload calls outside `@yadaw/ui`.
- Use semantic tokens; justify any domain palette or runtime signal color.
- Cover default, disabled/loading/error as applicable, long text, both themes, and keyboard state.
- Add a `play` test for multi-step behavior.
- Confirm focus, Escape, dismissal, and restoration for overlays.
- Confirm 320 px reflow and 200% text zoom for non-canvas UI.
- Run `pnpm lint:design`, UI tests, Storybook tests, and the static Storybook build.

The completed renderer inventory is recorded in
[design-system-audit.md](design-system-audit.md).
