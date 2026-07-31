import { describe, expect, it } from "vitest"
import { normalizedToPanUnits, panLabelFromNormalized, panUnitsToNormalized } from "./mixerPan"

describe("mixerPan", () => {
  it("converts normalized pan to discrete units with asymmetric left/right ranges", () => {
    expect(normalizedToPanUnits(0)).toBe(0)
    expect(normalizedToPanUnits(-1)).toBe(-64)
    expect(normalizedToPanUnits(1)).toBe(63)
    expect(normalizedToPanUnits(-0.5)).toBe(-32)
    expect(normalizedToPanUnits(0.5)).toBe(32)
    expect(normalizedToPanUnits(2)).toBe(63)
    expect(normalizedToPanUnits(-2)).toBe(-64)
  })

  it("round-trips pan units through normalized space", () => {
    for (const units of [-64, -32, -1, 0, 1, 32, 63]) {
      expect(normalizedToPanUnits(panUnitsToNormalized(units))).toBe(units)
    }
    expect(panUnitsToNormalized(100)).toBe(1)
    expect(panUnitsToNormalized(-100)).toBe(-1)
  })

  it("formats center, left, and right pan labels", () => {
    expect(panLabelFromNormalized(0)).toBe("C")
    expect(panLabelFromNormalized(-1)).toBe("L64")
    expect(panLabelFromNormalized(1)).toBe("R63")
    expect(panLabelFromNormalized(0.5)).toBe("R32")
  })
})
