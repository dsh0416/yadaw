import { describe, expect, it } from "vitest"
import { createEqualPowerFadeCurvePath, createEqualPowerFadeShadePath } from "./audioFadeCurve"

describe("audio fade curve", () => {
  it("maps the runtime equal-power fade-in gain across the full height", () => {
    const path = createEqualPowerFadeCurvePath("in")

    expect(path).toMatch(/^M 0 100 /)
    expect(path).toContain("L 50 29.289")
    expect(path).toMatch(/L 100 0$/)
  })

  it("mirrors the equal-power curve for fade-out and closes the attenuated area", () => {
    const curve = createEqualPowerFadeCurvePath("out")

    expect(curve).toMatch(/^M 0 0 /)
    expect(curve).toContain("L 50 29.289")
    expect(curve).toMatch(/L 100 100$/)
    expect(createEqualPowerFadeShadePath("out")).toBe(`${curve} L 100 0 L 0 0 Z`)
  })
})
