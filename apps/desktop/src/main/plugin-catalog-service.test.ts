import { describe, expect, it } from "vitest"
import type { PluginDescriptor } from "@yadaw/contracts"
import {
  canReuseCachedBundle,
  descriptorFromProbe,
  parseProbeStdout
} from "./plugin-catalog-service"

const plugin = {
  compatibility: "compatible"
} as PluginDescriptor

describe("canReuseCachedBundle", () => {
  it("reuses unchanged bundles unless a forced rescan is requested", () => {
    expect(
      canReuseCachedBundle({
        force: false,
        retryQuarantined: false,
        fingerprintMatches: true,
        previousPlugins: [plugin]
      })
    ).toBe(true)
    expect(
      canReuseCachedBundle({
        force: false,
        retryQuarantined: false,
        fingerprintMatches: false,
        previousPlugins: [plugin]
      })
    ).toBe(false)
    expect(
      canReuseCachedBundle({
        force: true,
        retryQuarantined: false,
        fingerprintMatches: true,
        previousPlugins: [plugin]
      })
    ).toBe(false)
  })

  it("retries quarantined bundles when requested", () => {
    expect(
      canReuseCachedBundle({
        force: false,
        retryQuarantined: true,
        fingerprintMatches: true,
        previousPlugins: [{ ...plugin, compatibility: "quarantined" }]
      })
    ).toBe(false)
  })
})

describe("parseProbeStdout", () => {
  it("accepts pure JSON and recovers JSON after plug-in stdout noise", () => {
    const payload = JSON.stringify({
      module: { path: "demo.vst3", vendor: "", classes: [{ classId: "1", categories: ["Fx"] }] }
    })
    expect(parseProbeStdout(payload).module?.classes?.[0]?.classId).toBe("1")
    expect(
      parseProbeStdout(`[info] initializing...\n${payload}\n`).module?.classes?.[0]?.classId
    ).toBe("1")
  })
})

describe("descriptorFromProbe", () => {
  it("derives dual mono only from native mono effect support", () => {
    const descriptor = descriptorFromProbe("effect.vst3", "Vendor", {
      classId: "effect",
      categories: ["Fx"],
      initialized: true,
      sample32: true,
      audioInputs: 1,
      audioOutputs: 1,
      supportedAudioModes: ["mono", "mono-to-stereo"]
    })

    expect(descriptor?.supportedAudioModes).toEqual(["mono", "mono-to-stereo", "dual-mono"])
    expect(descriptor?.categories).toEqual(["Fx"])
  })

  it("rejects probes that cannot negotiate an applicable main-bus mode", () => {
    const descriptor = descriptorFromProbe("instrument.vst3", "Vendor", {
      classId: "instrument",
      categories: ["Instrument", "Synth"],
      initialized: true,
      sample32: true,
      audioInputs: 0,
      audioOutputs: 1,
      eventInputs: 1,
      supportedAudioModes: ["mono-to-stereo"]
    })

    expect(descriptor).toMatchObject({
      compatibility: "unsupported-buses",
      supportedAudioModes: [],
      categories: ["Instrument", "Synth"]
    })
  })

  it("accepts legacy pipe-separated category strings from older probes", () => {
    const descriptor = descriptorFromProbe("legacy.vst3", "Vendor", {
      classId: "legacy",
      category: "Instrument|Sampler",
      initialized: true,
      sample32: true,
      audioInputs: 0,
      audioOutputs: 1,
      eventInputs: 1,
      supportedAudioModes: ["stereo"]
    })

    expect(descriptor).toMatchObject({
      kind: "instrument",
      categories: ["Instrument", "Sampler"]
    })
  })

  it("retains verified ARA factory metadata without changing insertion compatibility", () => {
    const descriptor = descriptorFromProbe("melody.vst3", "Vendor", {
      classId: "audio-module-class",
      categories: ["Fx"],
      initialized: true,
      sample32: true,
      audioInputs: 1,
      audioOutputs: 1,
      supportedAudioModes: ["stereo"],
      ara: {
        factoryClassId: "ara-main-factory-class",
        factoryId: "com.vendor.melody",
        documentArchiveId: "com.vendor.melody.archive",
        lowestApiGeneration: 4,
        highestApiGeneration: 6,
        playbackTransformationFlags: 7,
        supportsStoringAudioFileChunks: true
      }
    })

    expect(descriptor).toMatchObject({
      compatibility: "compatible",
      supportedAudioModes: ["stereo"],
      ara: {
        apiGeneration: 2,
        factoryClassId: "ara-main-factory-class",
        factoryId: "com.vendor.melody",
        documentArchiveId: "com.vendor.melody.archive",
        lowestApiGeneration: 4,
        highestApiGeneration: 6,
        playbackTransformationFlags: 7,
        supportsStoringAudioFileChunks: true
      }
    })
  })
})
