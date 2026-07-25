import { describe, expect, it } from "vitest"
import {
  dbToLevelPercent,
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_SCALE_MARKS,
  METER_MAX_DB,
  METER_MIN_DB,
  METER_SCALE_MARKS
} from "./mixerDbScale"

describe("mixer dB scales", () => {
  it("maps levels into a clamped bottom-up percentage", () => {
    expect(dbToLevelPercent(0, METER_MIN_DB, METER_MAX_DB)).toBe(100)
    expect(dbToLevelPercent(-30, METER_MIN_DB, METER_MAX_DB)).toBe(50)
    expect(dbToLevelPercent(-90, METER_MIN_DB, METER_MAX_DB)).toBe(0)
    expect(dbToLevelPercent(24, FADER_MIN_DB, FADER_MAX_DB)).toBe(100)
    expect(dbToLevelPercent(Number.NEGATIVE_INFINITY, FADER_MIN_DB, FADER_MAX_DB)).toBe(0)
  })

  it("keeps scale marks aligned with the same conversion used by the controls", () => {
    for (const mark of FADER_SCALE_MARKS) {
      expect(mark.position).toBeCloseTo(
        100 - dbToLevelPercent(mark.value, FADER_MIN_DB, FADER_MAX_DB)
      )
    }
    for (const mark of METER_SCALE_MARKS) {
      expect(mark.position).toBeCloseTo(
        100 - dbToLevelPercent(mark.value, METER_MIN_DB, METER_MAX_DB)
      )
    }
  })
})
