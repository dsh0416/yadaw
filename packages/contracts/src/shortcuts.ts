import type { ApplicationCommandId, DesktopPlatform } from "./application"

export const SHORTCUT_MODIFIERS = ["primary", "control", "alt", "shift"] as const
export type ShortcutModifier = (typeof SHORTCUT_MODIFIERS)[number]

export interface KeyboardShortcutBinding {
  code: string
  modifiers: ShortcutModifier[]
}

export interface MidiShortcutBinding {
  portId: string
  portName: string
  /** Zero-based MIDI channel. */
  channel: number
  type: "note" | "control-change"
  /** Note number or controller number, from 0 through 127. */
  number: number
}

export interface ShortcutPreferences {
  /**
   * Missing entries use the platform default. A null entry explicitly removes
   * the default binding.
   */
  keyboard: Partial<Record<ApplicationCommandId, KeyboardShortcutBinding | null>>
  midi: Partial<Record<ApplicationCommandId, MidiShortcutBinding>>
}

const PRIMARY = ["primary"] satisfies ShortcutModifier[]
const PRIMARY_SHIFT = ["primary", "shift"] satisfies ShortcutModifier[]

const COMMON_DEFAULTS: Readonly<
  Partial<Record<ApplicationCommandId, Readonly<KeyboardShortcutBinding>>>
> = {
  "project.new": { code: "KeyN", modifiers: PRIMARY },
  "project.open": { code: "KeyO", modifiers: PRIMARY },
  "project.save": { code: "KeyS", modifiers: PRIMARY },
  "project.close": { code: "KeyW", modifiers: PRIMARY },
  "project.settings": { code: "Comma", modifiers: PRIMARY_SHIFT },
  "edit.undo": { code: "KeyZ", modifiers: PRIMARY },
  "edit.redo": { code: "KeyZ", modifiers: PRIMARY_SHIFT },
  "edit.cut": { code: "KeyX", modifiers: PRIMARY },
  "edit.copy": { code: "KeyC", modifiers: PRIMARY },
  "edit.paste": { code: "KeyV", modifiers: PRIMARY },
  "edit.select-all": { code: "KeyA", modifiers: PRIMARY },
  "application.preferences": { code: "Comma", modifiers: PRIMARY },
  "transport.toggle-playback": { code: "Space", modifiers: [] },
  "transport.go-to-start": { code: "Home", modifiers: [] },
  "recording.toggle": { code: "KeyR", modifiers: [] },
  "view.toggle-mixer-dock": { code: "KeyM", modifiers: [] }
}

const FULL_SCREEN_DEFAULTS: Record<DesktopPlatform, Readonly<KeyboardShortcutBinding>> = {
  darwin: { code: "KeyF", modifiers: ["primary", "control"] },
  win32: { code: "F11", modifiers: [] },
  linux: { code: "F11", modifiers: [] }
}

export function defaultKeyboardShortcuts(
  platform: DesktopPlatform
): Readonly<Partial<Record<ApplicationCommandId, Readonly<KeyboardShortcutBinding>>>> {
  return {
    ...COMMON_DEFAULTS,
    "view.toggle-full-screen": FULL_SCREEN_DEFAULTS[platform]
  }
}

export function resolveKeyboardShortcuts(
  platform: DesktopPlatform,
  preferences: ShortcutPreferences
): Partial<Record<ApplicationCommandId, KeyboardShortcutBinding>> {
  const resolved: Partial<Record<ApplicationCommandId, KeyboardShortcutBinding>> = {}
  for (const [command, binding] of Object.entries(defaultKeyboardShortcuts(platform))) {
    resolved[command as ApplicationCommandId] = {
      code: binding.code,
      modifiers: [...binding.modifiers]
    }
  }
  for (const [command, binding] of Object.entries(preferences.keyboard)) {
    if (binding === null) delete resolved[command as ApplicationCommandId]
    else if (binding) {
      resolved[command as ApplicationCommandId] = {
        code: binding.code,
        modifiers: [...binding.modifiers]
      }
    }
  }
  return resolved
}

export function keyboardBindingMatches(
  binding: KeyboardShortcutBinding,
  event: {
    code: string
    ctrlKey: boolean
    altKey: boolean
    shiftKey: boolean
    metaKey: boolean
  },
  platform: DesktopPlatform
): boolean {
  const modifiers = new Set(binding.modifiers)
  const primaryDown = platform === "darwin" ? event.metaKey : event.ctrlKey
  const controlDown = platform === "darwin" ? event.ctrlKey : event.metaKey
  return (
    event.code === binding.code &&
    primaryDown === modifiers.has("primary") &&
    controlDown === modifiers.has("control") &&
    event.altKey === modifiers.has("alt") &&
    event.shiftKey === modifiers.has("shift")
  )
}

const KEY_LABELS: Record<string, string> = {
  Backspace: "Backspace",
  Comma: ",",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Escape: "Esc",
  Home: "Home",
  PageDown: "Page Down",
  PageUp: "Page Up",
  Period: ".",
  Space: "Space",
  Tab: "Tab"
}

export function keyboardCodeLabel(code: string): string {
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5)
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(code)) return code
  return KEY_LABELS[code] ?? code
}

export function formatKeyboardShortcut(
  binding: KeyboardShortcutBinding,
  platform: DesktopPlatform
): string {
  const labels = binding.modifiers.map((modifier) => {
    if (modifier === "primary") return platform === "darwin" ? "⌘" : "Ctrl"
    if (modifier === "control") return platform === "darwin" ? "Ctrl" : "Meta"
    if (modifier === "alt") return platform === "darwin" ? "⌥" : "Alt"
    return platform === "darwin" ? "⇧" : "Shift"
  })
  const separator = platform === "darwin" ? "" : "+"
  return [...labels, keyboardCodeLabel(binding.code)].join(separator)
}
