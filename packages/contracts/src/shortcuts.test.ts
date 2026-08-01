import { describe, expect, it } from "vitest"
import {
  defaultKeyboardShortcuts,
  formatKeyboardShortcut,
  keyboardBindingMatches,
  keyboardCodeLabel,
  resolveKeyboardShortcuts,
  type ShortcutPreferences
} from "./shortcuts"

describe("defaultKeyboardShortcuts", () => {
  it("uses platform-specific full-screen bindings", () => {
    expect(defaultKeyboardShortcuts("darwin")["view.toggle-full-screen"]).toEqual({
      code: "KeyF",
      modifiers: ["primary", "control"]
    })
    expect(defaultKeyboardShortcuts("win32")["view.toggle-full-screen"]).toEqual({
      code: "F11",
      modifiers: []
    })
    expect(defaultKeyboardShortcuts("linux")["view.toggle-full-screen"]).toEqual({
      code: "F11",
      modifiers: []
    })
  })

  it("includes common project and transport defaults", () => {
    const shortcuts = defaultKeyboardShortcuts("linux")
    expect(shortcuts["project.save"]).toEqual({ code: "KeyS", modifiers: ["primary"] })
    expect(shortcuts["transport.toggle-playback"]).toEqual({ code: "Space", modifiers: [] })
    expect(shortcuts["transport.toggle-loop"]).toEqual({ code: "KeyL", modifiers: [] })
    expect(shortcuts["edit.redo"]).toEqual({ code: "KeyZ", modifiers: ["primary", "shift"] })
    expect(shortcuts["edit.split-at-playhead"]).toEqual({
      code: "KeyE",
      modifiers: ["primary"]
    })
  })
})

describe("resolveKeyboardShortcuts", () => {
  it("applies overrides, keeps defaults, and honors explicit removals", () => {
    const preferences: ShortcutPreferences = {
      keyboard: {
        "project.save": { code: "KeyK", modifiers: ["primary", "shift"] },
        "recording.toggle": null
      },
      midi: {}
    }
    const resolved = resolveKeyboardShortcuts("win32", preferences)
    expect(resolved["project.save"]).toEqual({
      code: "KeyK",
      modifiers: ["primary", "shift"]
    })
    expect(resolved["recording.toggle"]).toBeUndefined()
    expect(resolved["project.open"]).toEqual({ code: "KeyO", modifiers: ["primary"] })
  })
})

describe("keyboardBindingMatches", () => {
  it("treats meta as primary on darwin and ctrl as primary elsewhere", () => {
    const binding = { code: "KeyS", modifiers: ["primary"] as const }
    expect(
      keyboardBindingMatches(
        { code: binding.code, modifiers: [...binding.modifiers] },
        { code: "KeyS", ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
        "darwin"
      )
    ).toBe(true)
    expect(
      keyboardBindingMatches(
        { code: binding.code, modifiers: [...binding.modifiers] },
        { code: "KeyS", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
        "linux"
      )
    ).toBe(true)
    expect(
      keyboardBindingMatches(
        { code: binding.code, modifiers: [...binding.modifiers] },
        { code: "KeyS", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
        "darwin"
      )
    ).toBe(false)
  })

  it("requires exact modifier and code matches", () => {
    const binding = { code: "KeyZ", modifiers: ["primary", "shift"] as const }
    expect(
      keyboardBindingMatches(
        { code: binding.code, modifiers: [...binding.modifiers] },
        { code: "KeyZ", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false },
        "win32"
      )
    ).toBe(true)
    expect(
      keyboardBindingMatches(
        { code: binding.code, modifiers: [...binding.modifiers] },
        { code: "KeyZ", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
        "win32"
      )
    ).toBe(false)
    expect(
      keyboardBindingMatches(
        { code: binding.code, modifiers: [...binding.modifiers] },
        { code: "KeyY", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false },
        "win32"
      )
    ).toBe(false)
  })
})

describe("keyboardCodeLabel", () => {
  it("formats letter, digit, function, and named keys", () => {
    expect(keyboardCodeLabel("KeyA")).toBe("A")
    expect(keyboardCodeLabel("Digit7")).toBe("7")
    expect(keyboardCodeLabel("F12")).toBe("F12")
    expect(keyboardCodeLabel("Space")).toBe("Space")
    expect(keyboardCodeLabel("Comma")).toBe(",")
    expect(keyboardCodeLabel("UnknownKey")).toBe("UnknownKey")
  })
})

describe("formatKeyboardShortcut", () => {
  it("formats darwin and non-darwin modifier sequences", () => {
    expect(
      formatKeyboardShortcut({ code: "KeyS", modifiers: ["primary", "shift"] }, "darwin")
    ).toBe("⌘⇧S")
    expect(formatKeyboardShortcut({ code: "KeyS", modifiers: ["primary", "shift"] }, "linux")).toBe(
      "Ctrl+Shift+S"
    )
    expect(
      formatKeyboardShortcut({ code: "KeyF", modifiers: ["primary", "control"] }, "darwin")
    ).toBe("⌘CtrlF")
    expect(formatKeyboardShortcut({ code: "KeyF", modifiers: ["control", "alt"] }, "win32")).toBe(
      "Meta+Alt+F"
    )
  })
})
