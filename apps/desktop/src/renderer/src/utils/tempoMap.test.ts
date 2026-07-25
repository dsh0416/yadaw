import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@yadaw/contracts"
import {
  musicalPositionAtTick,
  secondsToTick,
  tempoAtTick,
  tickToSeconds,
  timeSignatureAtTick
} from "./tempoMap"

const map: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [
    { tick: 0, beatsPerMinute: 120 },
    { tick: 3_840, beatsPerMinute: 60 }
  ],
  timeSignatureEvents: [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 3_840, numerator: 3, denominator: 4 }
  ]
}

describe("tempo map", () => {
  it("converts musical ticks through stepped tempo changes", () => {
    expect(tickToSeconds(map, 3_840)).toBe(2)
    expect(tickToSeconds(map, 4_800)).toBe(3)
    expect(secondsToTick(map, 3)).toBe(4_800)
  })

  it("reports values and musical position at the playhead", () => {
    expect(tempoAtTick(map, 4_800)).toBe(60)
    expect(timeSignatureAtTick(map, 4_800)).toMatchObject({
      numerator: 3,
      denominator: 4
    })
    expect(musicalPositionAtTick(map, 4_800)).toEqual({
      bar: 2,
      beat: 2,
      tick: 0
    })
  })
})
