import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@heron/contracts"
import GlobalMarkerLane from "./GlobalMarkerLane.vue"
import MeterTrackLane from "./MeterTrackLane.vue"

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 3_840, numerator: 3, denominator: 4 }
  ]
}

describe("MeterTrackLane", () => {
  it("removes a selected meter change without changing tempo events", async () => {
    const wrapper = mount(MeterTrackLane, {
      props: {
        tempoMap,
        selectedTick: 3_840,
        contentWidth: 800,
        pixelsPerQuarter: 50,
        height: 64
      }
    })

    await wrapper.get('[role="application"]').trigger("keydown", { key: "Delete" })
    const replacement = wrapper.emitted("replace")?.[0]?.[0] as TempoMapSnapshot
    expect(replacement.timeSignatureEvents).toEqual([{ tick: 0, numerator: 4, denominator: 4 }])
    expect(replacement.tempoEvents).toEqual(tempoMap.tempoEvents)
  })

  it("keeps the required tick-zero meter event", async () => {
    const wrapper = mount(MeterTrackLane, {
      props: {
        tempoMap,
        selectedTick: 0,
        contentWidth: 800,
        pixelsPerQuarter: 50,
        height: 64
      }
    })

    await wrapper.get('[role="application"]').trigger("keydown", { key: "Delete" })
    expect(wrapper.emitted("replace")).toBeUndefined()
  })

  it("snaps a moved meter event to the nearest bar without using its old boundary", async () => {
    const wrapper = mount(MeterTrackLane, {
      props: {
        tempoMap,
        selectedTick: 3_840,
        contentWidth: 800,
        pixelsPerQuarter: 50,
        height: 64
      }
    })

    wrapper.findComponent(GlobalMarkerLane).vm.$emit("update", "3840", 5.1)
    await wrapper.vm.$nextTick()

    const replacement = wrapper.emitted("replace")?.[0]?.[0] as TempoMapSnapshot
    expect(replacement.timeSignatureEvents).toEqual([
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 3_840, numerator: 3, denominator: 4 }
    ])
  })

  it("snaps a new meter event to a bar boundary", async () => {
    const wrapper = mount(MeterTrackLane, {
      props: {
        tempoMap: {
          ...tempoMap,
          timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
        },
        selectedTick: 0,
        contentWidth: 800,
        pixelsPerQuarter: 50,
        height: 64
      }
    })

    wrapper.findComponent(GlobalMarkerLane).vm.$emit("create", 3.6)
    await wrapper.vm.$nextTick()

    const replacement = wrapper.emitted("replace")?.[0]?.[0] as TempoMapSnapshot
    expect(replacement.timeSignatureEvents).toEqual([
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 3_840, numerator: 4, denominator: 4 }
    ])
  })
})
