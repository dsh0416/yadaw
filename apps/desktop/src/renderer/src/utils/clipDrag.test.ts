import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@heron/contracts"
import { clipStartSecondsFromPointer, findNearestTrackId } from "./clipDrag"

describe("clip drag snapping", () => {
  const tempoMap: TempoMapSnapshot = {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  }
  const lanes = [
    { trackId: "audio-1", top: 127, bottom: 227 },
    { trackId: "audio-2", top: 227, bottom: 347 },
    { trackId: "audio-3", top: 347, bottom: 427 }
  ]

  it("keeps the clip on the lane under the pointer", () => {
    expect(findNearestTrackId(lanes, 180)).toBe("audio-1")
    expect(findNearestTrackId(lanes, 300)).toBe("audio-2")
    expect(findNearestTrackId(lanes, 400)).toBe("audio-3")
  })

  it("snaps to the nearest edge outside the track rows", () => {
    expect(findNearestTrackId(lanes, 40)).toBe("audio-1")
    expect(findNearestTrackId(lanes, 500)).toBe("audio-3")
    expect(findNearestTrackId([], 200)).toBeNull()
  })

  it("preserves the grabbed point while clamping the clip to the timeline start", () => {
    expect(clipStartSecondsFromPointer(450, 100, tempoMap, 50, 50)).toBe(3)
    expect(clipStartSecondsFromPointer(110, 100, tempoMap, 50, 50)).toBe(0)
  })

  it("maps a musical drag position through the active tempo", () => {
    const fasterMap = {
      ...tempoMap,
      tempoEvents: [{ tick: 0, beatsPerMinute: 180 }]
    }
    expect(clipStartSecondsFromPointer(450, 100, fasterMap, 50, 50)).toBe(2)
  })
})
