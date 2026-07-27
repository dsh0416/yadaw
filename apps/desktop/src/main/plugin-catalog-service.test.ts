import { describe, expect, it } from "vitest"
import type { PluginDescriptor } from "@yadaw/contracts"
import { canReuseCachedBundle } from "./plugin-catalog-service"

const plugin = {
  compatibility: "compatible"
} as PluginDescriptor

describe("canReuseCachedBundle", () => {
  it("bypasses the fingerprint cache for a forced startup scan", () => {
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
