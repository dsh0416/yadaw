import { describe, expect, it } from "vitest"
import { parseProbeStdout } from "./plugin-descriptor-decoder"

describe("parseProbeStdout", () => {
  it("parses a clean JSON probe payload", () => {
    const payload = {
      module: {
        path: "/plugins/Demo.vst3",
        vendor: "Heron Studio",
        classes: [{ name: "Demo" }]
      }
    }

    expect(parseProbeStdout(JSON.stringify(payload))).toEqual(payload)
  })

  it("recovers the final JSON object when diagnostics precede it", () => {
    const payload = {
      module: {
        path: "/plugins/Noisy.vst3",
        vendor: "Vendor",
        classes: [{ classId: "abc" }]
      }
    }
    const stdout = [
      "VST3 factory enumerate start",
      "{not-json",
      "warning: skipped unsupported class",
      JSON.stringify(payload)
    ].join("\n")

    expect(parseProbeStdout(stdout)).toEqual(payload)
  })

  it("throws when no valid JSON descriptor is present", () => {
    expect(() => parseProbeStdout("probe failed\n{broken")).toThrow(
      "AudioPlugin probe returned an invalid descriptor"
    )
  })
})
