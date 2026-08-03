import { afterEach, describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { TempoMapSnapshot } from "@heron/contracts"
import TimelineRuler from "./TimelineRuler.vue"

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("TimelineRuler cycle lane", () => {
  it("previews a beat-snapped drag and commits one range without seeking", async () => {
    const wrapper = mount(TimelineRuler, {
      props: { contentWidth: 2_000, pixelsPerQuarter: 480, tempoMap },
      attachTo: document.body
    })
    const lane = wrapper.get(".cycle-lane")

    await lane.trigger("pointerdown", { pointerId: 4, clientX: 480 })
    await lane.trigger("pointermove", { pointerId: 4, clientX: 1_440 })
    expect(wrapper.get('[data-testid="cycle-range"]').attributes("style")).toContain("left: 480px")
    await lane.trigger("pointerup", { pointerId: 4, clientX: 1_440 })

    expect(wrapper.emitted("updateLoopRange")).toEqual([[{ startTick: 960, endTick: 2_880 }]])
    expect(wrapper.emitted("seek")).toBeUndefined()
  })

  it("does not edit the cycle range while external clock disables the lane", async () => {
    const wrapper = mount(TimelineRuler, {
      props: {
        contentWidth: 2_000,
        pixelsPerQuarter: 480,
        tempoMap,
        cycleDisabled: true,
        loopRange: { startTick: 960, endTick: 2_880 }
      },
      attachTo: document.body
    })

    await wrapper.get(".cycle-lane").trigger("pointerdown", { pointerId: 1, clientX: 480 })
    await wrapper.get('[data-testid="cycle-range"]').trigger("pointerdown", {
      pointerId: 2,
      clientX: 720
    })

    expect(wrapper.emitted("updateLoopRange")).toBeUndefined()
    expect(wrapper.emitted("seek")).toEqual([[0.5], [0.75]])
  })

  it("resizes an existing cycle range from its edges", async () => {
    const wrapper = mount(TimelineRuler, {
      props: {
        contentWidth: 2_000,
        pixelsPerQuarter: 480,
        tempoMap,
        loopEnabled: true,
        loopRange: { startTick: 960, endTick: 2_880 }
      },
      attachTo: document.body
    })

    await wrapper
      .get('[data-testid="cycle-edge-end"]')
      .trigger("pointerdown", { pointerId: 3, clientX: 1_440 })
    await wrapper
      .get('[data-testid="cycle-edge-end"]')
      .trigger("pointermove", { pointerId: 3, clientX: 1_920 })
    await wrapper
      .get('[data-testid="cycle-edge-end"]')
      .trigger("pointerup", { pointerId: 3, clientX: 1_920 })

    expect(wrapper.emitted("updateLoopRange")).toEqual([[{ startTick: 960, endTick: 3_840 }]])
    expect(wrapper.emitted("seek")).toBeUndefined()
  })
})
