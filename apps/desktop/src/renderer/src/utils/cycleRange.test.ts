import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@heron/contracts"
import { defaultCycleRange, previewCycleRange, snapTickToBeat } from "./cycleRange"

const map: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 7_680, numerator: 6, denominator: 8 }
  ]
}

describe("cycle range editing", () => {
  it("snaps to beats and creates a minimum one-beat range", () => {
    expect(snapTickToBeat(map, 1_390)).toBe(960)
    expect(previewCycleRange(map, null, "create", 1_390, 1_400)).toEqual({
      startTick: 960,
      endTick: 1_920
    })
  })

  it("resizes and moves while preserving valid bounds", () => {
    const range = { startTick: 960, endTick: 3_840 }
    expect(previewCycleRange(map, range, "resize-start", 960, 3_700)).toEqual({
      startTick: 2_880,
      endTick: 3_840
    })
    expect(previewCycleRange(map, range, "move", 960, 0)).toEqual({
      startTick: 0,
      endTick: 2_880
    })
  })

  it("creates the default region from the playhead bar", () => {
    expect(defaultCycleRange(map, 5_000)).toEqual({ startTick: 3_840, endTick: 7_680 })
    expect(defaultCycleRange(map, 8_000)).toEqual({ startTick: 7_680, endTick: 10_560 })
  })
})
