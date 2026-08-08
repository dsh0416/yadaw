import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"

import UiLevelMeter from "./UiLevelMeter.vue"

describe("UiLevelMeter", () => {
  it("renders a reusable channel meter, scale, held peak, and clip state", () => {
    const wrapper = mount(UiLevelMeter, {
      props: {
        levelPercent: 120,
        heldLevelPercent: 82,
        hasHeldPeak: true,
        clipped: true,
        channels: 2,
        label: "Vocal post-fader level",
        marks: [
          { value: 0, label: "0", position: 0, emphasis: true },
          { value: -60, label: "−∞", position: 100 }
        ]
      }
    })

    const meter = wrapper.get('[role="meter"]')
    expect(meter.attributes("aria-valuenow")).toBe("100")
    expect(meter.attributes("aria-label")).toBe("Vocal post-fader level")
    expect(meter.classes()).toEqual(expect.arrayContaining(["clipped", "has-held-peak"]))
    expect(meter.attributes("style")).toContain("--level-meter-level: 100%")
    expect(meter.findAll(":scope > span")).toHaveLength(2)
    expect(wrapper.text()).toContain("−∞")
  })
})
