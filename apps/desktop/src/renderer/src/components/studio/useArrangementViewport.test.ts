import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@heron/contracts"
import { clampTimelineViewportX, zoomedViewportScrollLeft } from "./useArrangementViewport"

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

describe("useArrangementViewport", () => {
  it("clamps zoom anchors to the timeline portion of the viewport", () => {
    expect(clampTimelineViewportX(100, 100, 220, 800)).toBe(0)
    expect(clampTimelineViewportX(520, 100, 220, 800)).toBe(200)
    expect(clampTimelineViewportX(2_000, 100, 220, 800)).toBe(800)
  })

  it("keeps zoom scroll positions at or beyond the timeline origin", () => {
    expect(zoomedViewportScrollLeft(tempoMap, 0.25, 120, 200)).toBe(0)
    expect(zoomedViewportScrollLeft(tempoMap, 4, 240, 100)).toBe(1_820)
  })
})
