import { describe, expect, it } from "vitest"
import type { PluginDescriptor } from "@yadaw/contracts"
import { canReuseCachedBundle, descriptorFromProbe } from "./plugin-catalog-service"

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

describe("descriptorFromProbe", () => {
  it("derives dual mono only from native mono effect support", () => {
    const descriptor = descriptorFromProbe("effect.vst3", "Vendor", {
      classId: "effect",
      category: "Fx",
      initialized: true,
      sample32: true,
      audioInputs: 1,
      audioOutputs: 1,
      supportedAudioModes: ["mono", "mono-to-stereo"]
    })

    expect(descriptor?.supportedAudioModes).toEqual(["mono", "mono-to-stereo", "dual-mono"])
  })

  it("rejects probes that cannot negotiate an applicable main-bus mode", () => {
    const descriptor = descriptorFromProbe("instrument.vst3", "Vendor", {
      classId: "instrument",
      category: "Instrument|Synth",
      initialized: true,
      sample32: true,
      audioInputs: 0,
      audioOutputs: 1,
      eventInputs: 1,
      supportedAudioModes: ["mono-to-stereo"]
    })

    expect(descriptor).toMatchObject({
      compatibility: "unsupported-buses",
      supportedAudioModes: []
    })
  })
})
