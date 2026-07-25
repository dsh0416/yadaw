import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import ArrangementZoomControls from "./ArrangementZoomControls.vue"

describe("ArrangementZoomControls", () => {
  it("renders three accessible sliders without numeric buttons", async () => {
    const wrapper = mount(ArrangementZoomControls, {
      props: {
        pixelsPerSecond: 100,
        trackHeight: 104,
        amplitudeScale: 1
      }
    })

    const time = wrapper.get('input[aria-label="Time zoom"]')
    const track = wrapper.get('input[aria-label="Track height"]')
    const gain = wrapper.get('input[aria-label="Waveform gain"]')
    expect(wrapper.findAll('input[type="range"]')).toHaveLength(3)
    expect(wrapper.findAll("button")).toHaveLength(0)

    await time.setValue(100)
    await track.setValue(50)
    await gain.setValue(0)

    expect(wrapper.emitted("setTime")?.[0]?.[0]).toBeCloseTo(1_600)
    expect(wrapper.emitted("setTrack")?.[0]).toEqual([196])
    expect(wrapper.emitted("setAmplitude")?.[0]?.[0]).toBeCloseTo(0.5)

    await time.trigger("dblclick")
    expect(wrapper.emitted("resetTime")).toHaveLength(1)
  })
})
