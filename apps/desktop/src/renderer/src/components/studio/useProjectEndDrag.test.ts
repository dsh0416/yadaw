import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@heron/contracts"
import { snapProjectEndTick } from "./useProjectEndDrag"

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

describe("project end snapping", () => {
  it("snaps to the nearest positive bar boundary", () => {
    expect(snapProjectEndTick(tempoMap, 5_500)).toBe(3_840)
    expect(snapProjectEndTick(tempoMap, 6_000)).toBe(7_680)
    expect(snapProjectEndTick(tempoMap, 1)).toBe(3_840)
  })
})
