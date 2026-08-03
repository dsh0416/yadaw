import { describe, expect, it } from "vitest"
import {
  formatKeyboardShortcut,
  keyboardBindingMatches,
  resolveKeyboardShortcuts
} from "@heron/contracts"

describe("shortcut bindings", () => {
  it("merges overrides and explicit removals over platform defaults", () => {
    const resolved = resolveKeyboardShortcuts("win32", {
      keyboard: {
        "project.save": { code: "KeyK", modifiers: ["primary", "shift"] },
        "recording.toggle": null
      },
      midi: {}
    })

    expect(resolved["project.save"]).toEqual({
      code: "KeyK",
      modifiers: ["primary", "shift"]
    })
    expect(resolved["recording.toggle"]).toBeUndefined()
    expect(resolved["project.open"]).toEqual({ code: "KeyO", modifiers: ["primary"] })
  })

  it("normalizes the primary modifier for each desktop platform", () => {
    const binding = { code: "KeyS", modifiers: ["primary"] as const }

    expect(
      keyboardBindingMatches(
        { code: binding.code, modifiers: [...binding.modifiers] },
        { code: "KeyS", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
        "win32"
      )
    ).toBe(true)
    expect(
      keyboardBindingMatches(
        { code: binding.code, modifiers: [...binding.modifiers] },
        { code: "KeyS", ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
        "darwin"
      )
    ).toBe(true)
    expect(formatKeyboardShortcut({ code: "Comma", modifiers: ["primary"] }, "darwin")).toBe("⌘,")
  })
})
