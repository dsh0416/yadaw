import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@heron/contracts"
import { secondsToTimelineX, timelineXToSeconds } from "./timelineCoordinates"

const map = (beatsPerMinute: number): TempoMapSnapshot => ({
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
})

describe("musical timeline coordinates", () => {
  it("preserves the existing scale at the 120 BPM reference tempo", () => {
    const pixelsPerQuarter = 50
    expect(pixelsPerQuarter).toBe(50)
    expect(secondsToTimelineX(map(120), 2, pixelsPerQuarter)).toBe(200)
  })

  it("makes fixed-duration audio occupy more beats at a faster tempo", () => {
    const pixelsPerQuarter = 50
    expect(secondsToTimelineX(map(60), 2, pixelsPerQuarter)).toBe(100)
    expect(secondsToTimelineX(map(120), 2, pixelsPerQuarter)).toBe(200)
    expect(secondsToTimelineX(map(180), 2, pixelsPerQuarter)).toBe(300)
  })

  it("round-trips timeline positions through stepped tempo changes", () => {
    const tempoMap: TempoMapSnapshot = {
      ticksPerQuarter: 960,
      tempoEvents: [
        { tick: 0, beatsPerMinute: 120 },
        { tick: 3_840, beatsPerMinute: 60 }
      ],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    }
    const pixelsPerQuarter = 50
    const x = secondsToTimelineX(tempoMap, 3, pixelsPerQuarter)
    expect(x).toBe(250)
    expect(timelineXToSeconds(tempoMap, x, pixelsPerQuarter)).toBe(3)
  })
})
