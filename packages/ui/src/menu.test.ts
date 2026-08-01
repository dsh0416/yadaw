import { describe, expect, it } from "vitest"
import type { UiMenuEntry } from "./menu"
import {
  countMenuTerminals,
  menuHasDetails,
  normalizeMenuSearchText,
  searchMenuEntries
} from "./menu"

const entries: readonly UiMenuEntry[] = [
  {
    kind: "group",
    id: "dynamics",
    label: "Dynamics",
    children: [
      {
        kind: "submenu",
        id: "builtin",
        label: "Built-in",
        children: [
          {
            kind: "item",
            id: "compressor",
            label: "Compressor",
            metadata: "stereo",
            keywords: ["level", "gain"]
          },
          {
            kind: "item",
            id: "gate",
            label: "Gate"
          }
        ]
      }
    ]
  },
  { kind: "separator", id: "separator" },
  {
    kind: "radio-group",
    id: "routes",
    label: "Outputs",
    value: "main",
    options: [
      { id: "main", label: "Main 1–2" },
      { id: "phones", label: "Headphones 3–4" }
    ]
  }
]

describe("menu search", () => {
  it("normalizes accents and full-width characters", () => {
    expect(normalizeMenuSearchText("  Ｃafé  ")).toBe("cafe")
  })

  it("flattens nested matches and retains their category path", () => {
    const results = searchMenuEntries(entries, "comp")

    expect(results.total).toBe(1)
    expect(results.entries).toEqual([
      expect.objectContaining({
        kind: "item",
        id: "compressor",
        label: "Compressor",
        metadata: "stereo · Dynamics / Built-in"
      })
    ])
  })

  it("matches declared keywords after visible label and category matches", () => {
    const results = searchMenuEntries(entries, "gain")

    expect(results.entries).toHaveLength(1)
    expect(results.entries[0]).toEqual(expect.objectContaining({ id: "compressor" }))
  })

  it("keeps radio semantics when a nested value is returned", () => {
    const results = searchMenuEntries(entries, "head")

    expect(results.entries).toEqual([
      {
        kind: "radio-group",
        id: "routes:search:phones",
        value: "main",
        options: [
          {
            id: "phones",
            label: "Headphones 3–4",
            metadata: "Outputs"
          }
        ]
      }
    ])
  })

  it("reports terminal counts and detailed content", () => {
    expect(countMenuTerminals(entries)).toBe(4)
    expect(menuHasDetails(entries)).toBe(true)
  })
})
