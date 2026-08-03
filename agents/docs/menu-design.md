# Context menu and dropdown menu design specification

This specification defines the shared menu language for Heron. It covers contextual commands
opened with a right click and command or selection menus opened from a button. Both entry points
must render the same content model so command names, ordering, states, shortcuts, search, and
nested categories do not drift between surfaces.

The design is optimized for a dense desktop DAW: common commands stay fast, the current editing
context remains visible, and large plug-in or routing taxonomies remain navigable without turning
every menu into a command palette.

## Design thesis

A menu is a temporary patch bay between the object under the pointer and the next operation. It
must make three things immediately legible:

1. what object or selection the commands apply to;
2. which rows perform an action and which rows open a category;
3. where a result belongs when search has flattened its hierarchy.

The signature Heron element remains outside the floating surface: the target track, clip, note,
slot, or route keeps its normal signal rail or selection outline while the menu is open. The menu
itself stays neutral and quiet. It must never resemble a second inspector.

## Component family

Use one shared menu content renderer behind these public interaction primitives:

| Primitive           | Opens from                          | Purpose                            | Value behavior            |
| ------------------- | ----------------------------------- | ---------------------------------- | ------------------------- |
| `UiContextMenu`     | Right click, Menu key, or Shift+F10 | Commands for a target or selection | Emits an action ID        |
| `UiDropdownMenu`    | Button or split-button disclosure   | Commands related to the trigger    | Emits an action ID        |
| `UiCascadingSelect` | Form or compact value trigger       | Choose one value from a hierarchy  | Owns a string model value |

`UiPopover` remains the primitive for persistent controls, explanatory content, sliders, forms,
or multiple independent inputs. A menu is for choosing a command or value and closes after a
terminal choice. Do not put text fields in a menu except for the optional menu search field.

The existing `UiCascadingMenu` should converge on the shared renderer rather than remain a
separate visual system. Product code must not import Reka menu primitives directly.

## Anatomy

```text
                  optional, root panel only
              ┌─────────────────────────────┐
              │  Search effects…         ⌕ │
              ├─────────────────────────────┤
 group label  │ Dynamics                    │
 action       │  Gate                  ⇧G   │
 submenu      │  Compressors              › │ ──┐
 separator    ├─────────────────────────────┤   │
 group label  │ Recent                      │   │
 selected     │ ✓ Pro-C 2                   │   │
              └─────────────────────────────┘   │
                                                │ 4 px gap
                         ┌──────────────────────┘
                         │  VCA                     ›
                         │  FET                     ›
                         │  Optical
                         └──────────────────────────
```

A row has stable columns:

```text
| check or icon, 16 | label, flexible | metadata or shortcut | submenu chevron, 12 |
```

- **Label** is required and uses sentence case.
- **Icon** is optional and supplements the label. Do not decorate only a few ordinary commands.
- **Shortcut** shows the effective application shortcut, not a hard-coded platform guess.
- **Metadata** may show a concise format such as `stereo`, `48 kHz`, or a category path. It does
  not carry essential state by itself.
- **Chevron** is reserved for a submenu and mirrors in right-to-left layouts.
- Single-select and radio menus reserve the check column for all peer rows. Other omitted columns
  do not retain decorative placeholders.

## Information architecture

### Groups and categories are different

A **group** is a non-interactive section in the current panel. Use it for a short semantic
partition such as Edit, Transform, and Render. A group may have a muted label or only a separator
when the meaning is already clear.

A **category** is an interactive row that opens a submenu. Use it when placing all children in the
current panel would slow scanning or make the panel excessively tall. Never create a submenu to
hide only one enabled command.

Order command menus as follows:

1. likely object-specific commands;
2. transformation or routing categories;
3. clipboard and organizational commands;
4. destructive commands in the final group.

Alphabetical order suits large peer sets such as plug-in manufacturers. It is not a substitute
for workflow order in a short command menu. Favorites and recent items may form clearly labeled
first groups, but do not reorder the stable main taxonomy.

### Depth and size

- Support recursive data, but expose no more than **three panels at once**: root plus two nested
  submenus. Regroup or flatten a deeper taxonomy.
- Prefer 4–10 rows per panel. Show up to 16 rows before the panel scrolls.
- When an unfiltered tree has more than 20 terminal items, offer search by default.
- Split a category with more than 40 direct children or rely on search. Do not invent `A–F`
  buckets unless alphabetical retrieval matches the user's mental model.
- Remove a redundant category level when fewer than two enabled terminal choices remain.

## Optional search

Search belongs only to the root panel and searches all terminal descendants. Short command menus
open with the first enabled action ready and do not gain an unnecessary focus stop.

### Search behavior

1. Match case-insensitively against the localized label, declared keywords, and category names.
   Normalize accents and full-width/half-width forms. IDs are not user-visible keywords.
2. Rank exact prefix matches, word-prefix matches, then substring or declared-keyword matches.
   Preserve source order within the same rank.
3. With an empty query, show the normal grouped and nested tree.
4. With a non-empty query, show a **flat result list**. Each result retains its terminal label and
   a muted breadcrumb such as `Dynamics / Compressor`.
5. Do not show submenu rows in results. Choosing a result immediately runs or selects the
   terminal item.
6. Keep at most 12 results visible. Scroll longer lists and announce the result count. A very
   large source may cap results and append `Type more to narrow results`.
7. No-result copy reads `No results for “{query}”` and may add a concrete hint. It is a status,
   not a disabled menu item.

Search disabled commands only when the product deliberately shows why they are unavailable.
Filtering may be host-controlled for asynchronous sources, but the rendered behavior stays the
same.

### Search focus

- A button-opened searchable dropdown focuses search on open.
- A pointer-opened context menu highlights the first enabled item. Typing a printable character,
  `/`, or Ctrl/Cmd+F focuses search and applies the character where appropriate.
- A keyboard-opened context menu focuses search only when search is its primary retrieval method;
  otherwise it highlights the first enabled item.
- Arrow Down from search moves to the first result. Arrow Up from the first result returns to it.
- Escape with a query clears the query. Escape with an empty query closes the tree and restores
  focus.
- Closing clears the transient query unless the product is a persistent picker rather than a
  menu.

IME composition must finish before Enter chooses a result. Do not filter or activate while
`KeyboardEvent.isComposing` is true.

## Invocation and targeting

### Context menus

- Open at the pointer hotspot with a 2 px visual offset. The Menu key or Shift+F10 opens at the
  focused object's start edge.
- Right-clicking outside the current selection targets that object before the menu is built.
  Right-clicking a member of a multi-selection preserves the full selection.
- Right-clicking empty canvas space uses canvas or insert commands; it does not silently retain a
  stale clip or note target.
- Keep the target's normal selected treatment or signal rail visible until close. Do not add a
  second colored outline solely for the menu.
- Do not replace the browser/OS editing menu in text or numeric entry unless Cut, Copy, Paste,
  Select all, undo behavior, and disabled states are all provided correctly.
- Every pointer-only context menu has a discoverable equivalent: dropdown button, application menu
  command, shortcut, or documented keyboard invocation.

Prevent the native `contextmenu` event only when an enabled product menu can actually open. A
loading or unavailable menu must not leave the user with no response.

### Dropdown menus

- The trigger is a semantic button with an accessible name and `aria-haspopup="menu"`.
- Use a downward chevron for disclosure. Use an ellipsis only for a collection of secondary
  commands, not as a generic menu affordance.
- Reopening starts at the first enabled row for actions and at the current value for selections.
- A command menu may contain checked toggles. A value menu uses radio semantics. Do not mix a form
  value picker and unrelated commands in one undifferentiated group.

## Pointer and keyboard interaction

| Input                 | Behavior                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| Click / Enter / Space | Run a terminal item or open a submenu; close after a terminal choice         |
| Right click           | Open the context menu for the resolved target                                |
| Arrow Down / Up       | Move through enabled rows in the current panel, wrapping at the ends         |
| Arrow Right           | Open a submenu and highlight its first enabled item                          |
| Arrow Left            | Close the submenu and restore highlight to its parent                        |
| Home / End            | Move to the first / last enabled row in the panel                            |
| Printable key         | Typeahead in ordinary menus; enter search in searchable menus                |
| Enter                 | Choose the highlighted terminal item; never choose during IME composition    |
| Escape                | Clear search first, then close the full menu tree                            |
| Tab                   | Close and continue normal document focus order; do not cycle inside the menu |

Submenus open immediately from keyboard. With a pointer, open after 120–180 ms hover intent and
keep a pointer grace area toward the child panel for about 300 ms. Diagonal movement into a
submenu must not activate rows crossed on the way. Clicking a submenu row opens it and never emits
a terminal action.

## Placement and collision

- Dropdown root aligns its start edge with the trigger and uses a 4 px side offset.
- Context root anchors to the pointer or keyboard-derived target point.
- Submenus open toward the inline end with a 4 px gap and slight negative block-axis alignment.
- Keep 8 px viewport padding. Shift along an edge before flipping sides.
- A child may overlap the target but must not cover its parent row.
- Maximum panel height is `min(420px, 100dvh - 16px)`. Scroll only the active panel and never
  show a horizontal scrollbar.
- Close or reposition when the target is removed, leaves its local viewport, or window geometry
  changes materially.

### Panel scrollbar

- Only the active panel scrolls. Horizontal overflow is clipped.
- Use an 8 CSS px interaction lane with a 4 px visible thumb created by a 2 px transparent
  inset. Do not show platform arrow buttons.
- The track and corner remain transparent so the panel reads as one continuous raised surface.
- The resting thumb derives from `--ui-color-text-subtle`, hover uses
  `--ui-color-text-muted`, and active dragging uses `--ui-color-action`.
- Keep a 24 px minimum thumb length. Wheel, touchpad, touch, Page Up/Down, Home/End, and menu
  keyboard navigation retain native scrolling behavior.
- Apply the same scrollbar to context roots, dropdown roots, search results, and submenu panels.
  In forced-colors mode, return control of the scrollbar palette to the operating system.

## Visual specification

Existing Heron semantic tokens are the source of truth. Do not introduce raw menu colors or
numeric z-indexes.

| Property              | Compact workspace             | Standard UI                  |
| --------------------- | ----------------------------- | ---------------------------- |
| Root width            | 220 px preferred; 180–280 px  | 240 px preferred; 200–320 px |
| Detailed/search width | 260–320 px                    | 280–360 px                   |
| Row height            | 28 px; 24 px absolute minimum | 32 px                        |
| Search height         | 28 px                         | 32 px                        |
| Panel padding         | 5 px                          | 6 px                         |
| Row inline padding    | 8 px                          | 10 px                        |
| Panel radius          | 7 px                          | `--ui-radius-md`             |
| Inter-panel gap       | 4 px                          | 4 px                         |

Shared menus default to the lower bound for detailed and searchable roots: 260 px in compact
workspaces and 280 px in standard UI. Widen only when visible labels or metadata require it.

- Floating menu surfaces use the neutral `--ui-color-menu-*` role tokens plus
  `--ui-shadow-md` and `--ui-z-dropdown`. Do not inherit the general blue-tinted raised-surface
  palette or fill a highlighted row with the saturated action color.
- Highlight stays neutral gray and uses `--ui-color-menu-accent` only as a narrow leading edge.
- Labels use the interface family. Shortcuts, channel numbers, dB, BPM, and technical metadata
  use the data family.
- Pointer and keyboard highlight share one visual treatment. Focus remains visible in
  forced-colors mode when the fill is removed.
- A persistent value uses a check or radio indicator plus a subtle selection surface. Highlight
  is temporary; selected is persistent.
- Disabled rows use `--ui-opacity-disabled`, cannot highlight, and may expose an accessible
  reason. Avoid tooltips inside nested menus because they compete with submenu hover intent.
- A destructive terminal item uses `--ui-color-danger` for its default icon and label. Highlight
  uses the normal highlight. Irreversible commitment still opens `UiAlertDialog`.
- Group labels use muted small text and sentence case. All caps are only for domain abbreviations
  such as MIDI.
- Open and close use one 100 ms fade with at most 2 px translation. Submenus do not stagger.
  Reduced motion removes the translation.

Long labels truncate only after the shortcut and submenu columns remain visible. The full label
stays available to assistive technology. Localization may grow a panel to its maximum width; it
must not reduce text below the system type scale.

## States

Every applicable row or panel defines:

- **Default** — available, not current.
- **Highlighted** — current pointer or keyboard destination.
- **Open** — submenu parent with a visible child; visually equivalent to highlighted.
- **Selected / checked** — persistent state, independent of highlight.
- **Disabled** — named but unavailable; never focusable or actionable.
- **Busy** — prevents duplicate activation and retains its label. Prefer closing and reporting
  longer work through the global operation pattern.
- **Empty search** — status with search still editable.
- **Loading** — one named loading status when asynchronous loading cannot be avoided.
- **Error** — states what failed; recovery that requires multiple controls belongs outside menu.

## Content model

The shared renderer consumes an explicit discriminated union. Product hosts derive it from stores
and translate the emitted stable ID into intent. `@heron/ui` does not read Pinia, Electron, IPC,
or project data.

```ts
type UiMenuEntry =
  | {
      kind: "item"
      id: string
      label: string
      icon?: UiMenuIconName
      shortcut?: string
      metadata?: string
      keywords?: readonly string[]
      disabled?: boolean
      disabledReason?: string
      tone?: "default" | "danger"
    }
  | {
      kind: "submenu"
      id: string
      label: string
      children: readonly UiMenuEntry[]
      icon?: UiMenuIconName
      disabled?: boolean
    }
  | {
      kind: "group"
      id: string
      label?: string
      children: readonly UiMenuEntry[]
    }
  | { kind: "separator"; id: string }
  | {
      kind: "checkbox"
      id: string
      label: string
      checked: boolean
      disabled?: boolean
    }
  | {
      kind: "radio-group"
      id: string
      label?: string
      value: string
      options: readonly { id: string; label: string; disabled?: boolean }[]
    }
```

The exported API may adapt this sketch, but it retains explicit entry kinds. Do not infer
separators, submenus, danger, or selection semantics from missing values or label strings. IDs
are stable within a menu and labels are localizable. Search configuration supplies an accessible
label, placeholder, empty copy, and optional declared keywords.

## Accessibility

- Use `menu`, `menuitem`, `menuitemcheckbox`, and `menuitemradio` only for desktop-like
  application commands and choices. Use listbox or combobox semantics for editable form entry.
- A trigger exposes expanded state. A context menu has a name associated with its target or
  selection.
- Roving focus keeps one highlighted item per open panel and skips disabled rows.
- Keyboard opening moves focus into the menu. Closing restores it to the trigger or target. If an
  action removes that target, the product host selects the nearest stable focus target.
- Group labels and separators are not focusable. Labeled groups have programmatic association.
- Result counts and no-results status use polite announcement. Do not announce every result while
  the user composes.
- At 200% text zoom, use maximum width and vertical scroll. At 320 CSS px, show one panel at a time
  with a visible Back row instead of squeezing side-by-side panels off-screen.
- Forced-colors mode retains panel borders, current-item outline, checked indicators, and disabled
  differentiation.

## Product examples

### Arrangement clip context menu

```text
Open in piano roll                         Enter
Rename                                    F2
───────────────────────────────────────────────
Edit                                      ›
Transform                                 ›
Bounce                                    ›
───────────────────────────────────────────────
Delete                                    Del
```

The clicked clip becomes the context target unless it belongs to the current multi-selection.
Delete is last and uses danger text, but needs no confirmation when it is immediately undoable.

### Searchable audio effect dropdown

An empty query shows Favorites and Recent groups followed by nested categories. The query
`comp` shows terminal results directly:

```text
Search effects…                                      ×
───────────────────────────────────────────────────────
Compressor             Dynamics / Built-in
Pro-C 2                Dynamics / FabFilter
OTT                    Dynamics / Xfer Records
```

The path is metadata, not part of the action name. Choosing emits the stable plug-in ID.

### Output routing selection

Use `UiCascadingSelect` with radio semantics. Hardware outputs and buses may be categories; the
current route is checked. Search is unnecessary for a small project but may turn on when routable
targets exceed the threshold.

## Implementation and review checklist

- Context and dropdown wrappers render the same item model and styles.
- Target resolution and multi-selection behavior are tested before opening.
- Search is optional, root-only, recursive, localized, IME-safe, and flat while filtering.
- Empty, long-label, disabled, checked, danger, loading, and no-result states are covered.
- Root plus two nested levels work with pointer and keyboard; deeper data is regrouped.
- Submenu hover grace prevents diagonal pointer loss.
- Placement flips and shifts with 8 px viewport padding at every window edge.
- Escape, Tab, focus restoration, Menu key, Shift+F10, and typeahead/search are tested.
- Editable text keeps a complete editing menu or the native menu.
- Dark, light, forced-colors, reduced-motion, 200% zoom, and 320 CSS px are reviewed.
- Storybook includes action, single-select, searchable taxonomy, nested submenu, and edge-collision
  stories with Axe configured to fail on violations.
- Product components pass data and handle emitted intent; shared UI remains free of product stores
  and preload calls.
