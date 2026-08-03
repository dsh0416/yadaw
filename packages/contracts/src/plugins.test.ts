import { describe, expect, it } from "vitest"

import {
  defaultPluginCategories,
  normalizePluginDescriptor,
  parsePluginCategories,
  pluginCategoriesLabel,
  pluginDescriptorKey,
  pluginLooksLikeInstrument,
  type PluginDescriptor
} from "./plugins"

function descriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    source: { kind: "external" },
    classId: "class-id",
    modulePath: "/plugins/Reverb.vst3",
    name: "Reverb",
    vendor: "Heron",
    version: "1.0.0",
    categories: ["Fx", "Reverb"],
    kind: "effect",
    supportedAudioModes: ["stereo"],
    architecture: "x86_64",
    buses: [],
    hasEditor: false,
    compatibility: "compatible",
    compatibilityReason: null,
    ...overrides
  }
}

describe("pluginDescriptorKey", () => {
  it("keys external plugins by module path so two bundles never collide", () => {
    const first = descriptor({ modulePath: "/a/Reverb.vst3" })
    const second = descriptor({ modulePath: "/b/Reverb.vst3" })

    expect(pluginDescriptorKey(first)).toBe("/a/Reverb.vst3:class-id")
    expect(pluginDescriptorKey(first)).not.toBe(pluginDescriptorKey(second))
  })

  it("keys builtin plugins by their builtin id rather than the module path", () => {
    const builtin = descriptor({
      source: { kind: "builtin", id: "heron-gain" },
      modulePath: "/wherever/it/was/installed.vst3"
    })

    expect(pluginDescriptorKey(builtin)).toBe("heron-gain:class-id")
  })

  it("distinguishes classes shipped inside the same bundle", () => {
    const bundle = "/plugins/Suite.vst3"

    expect(pluginDescriptorKey(descriptor({ modulePath: bundle, classId: "a" }))).not.toBe(
      pluginDescriptorKey(descriptor({ modulePath: bundle, classId: "b" }))
    )
  })
})

describe("parsePluginCategories", () => {
  it("splits VST3 pipe-separated subcategory strings", () => {
    expect(parsePluginCategories("Fx|Reverb|Stereo")).toEqual(["Fx", "Reverb", "Stereo"])
  })

  it("trims whitespace and drops empty segments", () => {
    expect(parsePluginCategories(" Fx | | Delay ||")).toEqual(["Fx", "Delay"])
  })

  it("returns an empty list for an empty string", () => {
    expect(parsePluginCategories("")).toEqual([])
  })

  it("normalizes arrays the same way as strings", () => {
    expect(parsePluginCategories([" Instrument ", "", "Synth"])).toEqual(["Instrument", "Synth"])
  })

  it("treats null and undefined as no categories", () => {
    expect(parsePluginCategories(null)).toEqual([])
    expect(parsePluginCategories(undefined)).toEqual([])
  })

  it("copies the input array instead of mutating it", () => {
    const input = [" Fx "] as const
    const parsed = parsePluginCategories(input)

    expect(parsed).not.toBe(input)
    expect(input[0]).toBe(" Fx ")
  })
})

describe("defaultPluginCategories", () => {
  it("labels instruments as both instrument and synth", () => {
    expect(defaultPluginCategories("instrument")).toEqual(["Instrument", "Synth"])
  })

  it("labels effects with the VST3 Fx category", () => {
    expect(defaultPluginCategories("effect")).toEqual(["Fx"])
  })

  it("produces defaults that classify consistently with pluginLooksLikeInstrument", () => {
    expect(pluginLooksLikeInstrument(defaultPluginCategories("instrument"))).toBe(true)
    expect(pluginLooksLikeInstrument(defaultPluginCategories("effect"))).toBe(false)
  })
})

describe("pluginCategoriesLabel", () => {
  it("joins categories with a middle dot by default", () => {
    expect(pluginCategoriesLabel(["Fx", "Reverb"])).toBe("Fx · Reverb")
  })

  it("honors a custom separator", () => {
    expect(pluginCategoriesLabel(["Fx", "Reverb"], ", ")).toBe("Fx, Reverb")
  })

  it("renders an empty label when there are no categories", () => {
    expect(pluginCategoriesLabel([])).toBe("")
  })
})

describe("pluginLooksLikeInstrument", () => {
  it("matches the Instrument and Synth categories case-insensitively", () => {
    expect(pluginLooksLikeInstrument(["INSTRUMENT"])).toBe(true)
    expect(pluginLooksLikeInstrument(["synth"])).toBe(true)
  })

  it("matches categories that merely contain the keywords", () => {
    expect(pluginLooksLikeInstrument(["Instrument|Sampler"])).toBe(true)
    expect(pluginLooksLikeInstrument(["Synthesizer"])).toBe(true)
  })

  it("rejects effect-only categories", () => {
    expect(pluginLooksLikeInstrument(["Fx", "Reverb", "Dynamics"])).toBe(false)
    expect(pluginLooksLikeInstrument([])).toBe(false)
  })
})

/** A snapshot from before `categories` existed: one pipe-separated `category` string. */
function legacyDescriptor(category: string): PluginDescriptor & { category?: string } {
  const value = { ...descriptor(), category }
  delete (value as { categories?: unknown }).categories
  return value
}

describe("normalizePluginDescriptor", () => {
  it("upgrades the legacy pipe-separated category field", () => {
    const normalized = normalizePluginDescriptor(legacyDescriptor("Fx|Delay"))

    expect(normalized.categories).toEqual(["Fx", "Delay"])
  })

  it("drops the legacy category field from the result", () => {
    const normalized = normalizePluginDescriptor(legacyDescriptor("Fx"))

    expect(normalized).not.toHaveProperty("category")
  })

  it("treats an explicit empty categories array as authoritative over the legacy field", () => {
    const normalized = normalizePluginDescriptor({
      ...descriptor({ categories: [] }),
      category: "Fx|Delay"
    })

    expect(normalized.categories).toEqual(["Fx"])
  })

  it("prefers the modern categories array over the legacy field", () => {
    const legacy = { ...descriptor({ categories: ["Reverb"] }), category: "Delay" }

    expect(normalizePluginDescriptor(legacy).categories).toEqual(["Reverb"])
  })

  it("assumes an effect when a snapshot predates the kind field", () => {
    const withoutKind = descriptor({ categories: [] })
    delete (withoutKind as { kind?: unknown }).kind

    expect(normalizePluginDescriptor(withoutKind).categories).toEqual(["Fx"])
  })

  it("falls back to kind defaults when no categories survive parsing", () => {
    const effect = normalizePluginDescriptor({ ...descriptor(), categories: [] })
    const instrument = normalizePluginDescriptor({
      ...descriptor({ kind: "instrument" }),
      categories: ["  "]
    })

    expect(effect.categories).toEqual(["Fx"])
    expect(instrument.categories).toEqual(["Instrument", "Synth"])
  })

  it("defaults snapshots without supportedAudioModes to stereo", () => {
    const withoutModes = descriptor()
    // Snapshots written before the field existed have no array here.
    delete (withoutModes as { supportedAudioModes?: unknown }).supportedAudioModes

    expect(normalizePluginDescriptor(withoutModes).supportedAudioModes).toEqual(["stereo"])
  })

  it("keeps declared audio modes untouched", () => {
    const modes = normalizePluginDescriptor(
      descriptor({ supportedAudioModes: ["mono", "dual-mono"] })
    ).supportedAudioModes

    expect(modes).toEqual(["mono", "dual-mono"])
  })

  it("removes derived dual mono from ARA descriptors", () => {
    const ara = descriptor({
      supportedAudioModes: ["mono", "stereo", "dual-mono"],
      ara: {
        apiGeneration: 2,
        factoryClassId: "ara-factory",
        factoryId: "com.vendor.ara",
        documentArchiveId: "com.vendor.ara.archive",
        lowestApiGeneration: 4,
        highestApiGeneration: 5,
        playbackTransformationFlags: 0,
        supportsStoringAudioFileChunks: false
      }
    })

    expect(normalizePluginDescriptor(ara).supportedAudioModes).toEqual(["mono", "stereo"])
  })

  it("preserves every other descriptor field", () => {
    const original = descriptor({
      hasEditor: true,
      compatibility: "quarantined",
      compatibilityReason: "crashed during scan",
      ara: {
        apiGeneration: 2,
        factoryClassId: "factory-class",
        factoryId: "factory",
        documentArchiveId: "archive",
        lowestApiGeneration: 1,
        highestApiGeneration: 2,
        playbackTransformationFlags: 3,
        supportsStoringAudioFileChunks: true
      }
    })

    expect(normalizePluginDescriptor(original)).toEqual(original)
  })

  it("is idempotent", () => {
    const once = normalizePluginDescriptor({
      ...descriptor(),
      categories: [],
      category: "Fx|Delay"
    })

    expect(normalizePluginDescriptor(once)).toEqual(once)
  })
})
