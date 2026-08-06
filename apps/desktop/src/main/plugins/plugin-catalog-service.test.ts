import { describe, expect, it } from "vitest"
import type { PluginDescriptor } from "@heron/contracts"
import {
  canReuseCachedBundle,
  descriptorFromProbe,
  descriptorsFromModuleInfo,
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

describe("descriptorsFromModuleInfo", () => {
  it("builds soft catalog entries from moduleinfo without requiring a probe", () => {
    const descriptors = descriptorsFromModuleInfo("/Library/Audio/Plug-Ins/VST3/Demo.vst3", {
      Version: "1.2.3",
      "Factory Info": { Vendor: "Acme" },
      Classes: [
        {
          CID: "ABCDEF0123456789ABCDEF0123456789",
          Category: "Audio Module Class",
          Name: "Demo Delay",
          Vendor: "Acme Audio",
          Version: "1.2.3",
          "Sub Categories": ["Fx", "Delay"]
        },
        {
          CID: "FEDCBA9876543210FEDCBA9876543210",
          Category: "Audio Module Class",
          Name: "Demo Synth",
          "Sub Categories": ["Instrument", "Synth"]
        },
        {
          CID: "ignored",
          Category: "Service Class",
          Name: "Helper"
        }
      ]
    })

    expect(descriptors).toHaveLength(2)
    expect(descriptors[0]).toMatchObject({
      locator: {
        format: "vst3",
        artifactPath: "/Library/Audio/Plug-Ins/VST3/Demo.vst3",
        nativeId: "ABCDEF0123456789ABCDEF0123456789"
      },
      name: "Demo Delay",
      vendor: "Acme Audio",
      kind: "effect",
      categories: ["Fx", "Delay"],
      compatibility: "compatible",
      supportedAudioModes: ["mono", "mono-to-stereo", "stereo", "dual-mono"]
    })
    expect(descriptors[1]).toMatchObject({
      locator: {
        format: "vst3",
        artifactPath: "/Library/Audio/Plug-Ins/VST3/Demo.vst3",
        nativeId: "FEDCBA9876543210FEDCBA9876543210"
      },
      name: "Demo Synth",
      kind: "instrument",
      categories: ["Instrument", "Synth"],
      compatibility: "compatible",
      supportedAudioModes: ["mono", "stereo"]
    })
  })

  it("marks modules without Audio Module classes as needing factory enumeration", () => {
    const [descriptor] = descriptorsFromModuleInfo("legacy.vst3", {
      "Factory Info": { Vendor: "Legacy" },
      Classes: []
    })
    expect(descriptor).toMatchObject({
      locator: {
        format: "vst3",
        artifactPath: "legacy.vst3",
        nativeId: "unprobed:legacy.vst3"
      },
      compatibility: "load-error",
      supportedAudioModes: []
    })
  })

  it("still exposes Audio Module classes when an ARA factory is also listed", () => {
    const descriptors = descriptorsFromModuleInfo("melody.vst3", {
      "Factory Info": { Vendor: "Acme" },
      Classes: [
        {
          CID: "ABCDEF0123456789ABCDEF0123456789",
          Category: "Audio Module Class",
          Name: "Melody",
          "Sub Categories": ["Fx"]
        },
        {
          CID: "ARAFACTORY0123456789ABCDEF012345",
          Category: "ARA Main Factory Class",
          Name: "Melody"
        }
      ]
    })
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]?.name).toBe("Melody")
    expect(descriptors[0]?.ara).toBeUndefined()
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

  it("does not derive dual mono for an ARA effect", () => {
    const descriptor = descriptorFromProbe("ara-effect.vst3", "Vendor", {
      classId: "ara-effect",
      categories: ["Fx"],
      initialized: true,
      sample32: true,
      audioInputs: 1,
      audioOutputs: 1,
      supportedAudioModes: ["mono", "mono-to-stereo", "stereo"],
      ara: {
        factoryClassId: "ara-main-factory-class",
        factoryId: "com.vendor.ara-effect",
        documentArchiveId: "com.vendor.ara-effect.archive",
        lowestApiGeneration: 4,
        highestApiGeneration: 5,
        playbackTransformationFlags: 0,
        supportsStoringAudioFileChunks: false
      }
    })

    expect(descriptor?.supportedAudioModes).toEqual(["mono", "mono-to-stereo", "stereo"])
  })
})
