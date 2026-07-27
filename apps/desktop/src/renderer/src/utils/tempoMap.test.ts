import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@yadaw/contracts"
import {
  barTicksWithinSeconds,
  beatTicksThroughTick,
  musicalPositionAtTick,
  replaceTempoEventAtTick,
  secondsToTick,
  tempoEventAtTick,
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
    expect(tempoEventAtTick(map, 4_800)).toEqual({
      tick: 3_840,
      beatsPerMinute: 60
    })
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

  it("replaces the active event without inserting a marker at the playhead", () => {
    const replaced = replaceTempoEventAtTick(map, 4_800, 72.5)

    expect(replaced.tempoEvents).toEqual([
      { tick: 0, beatsPerMinute: 120 },
      { tick: 3_840, beatsPerMinute: 72.5 }
    ])
    expect(map.tempoEvents[1]?.beatsPerMinute).toBe(60)
  })

  it("places bar guides using both tempo and time-signature changes", () => {
    expect(barTicksWithinSeconds(map, 5)).toEqual([0, 3_840, 6_720])
  })

  it("places beat guides between bars and follows the active denominator", () => {
    expect(
      beatTicksThroughTick(
        {
          ...map,
          timeSignatureEvents: [
            { tick: 0, numerator: 4, denominator: 4 },
            { tick: 3_840, numerator: 6, denominator: 8 }
          ]
        },
        6_720
      )
    ).toEqual([960, 1_920, 2_880, 4_320, 4_800, 5_280, 5_760, 6_240])
  })
})
