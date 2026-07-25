import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { TempoMapSnapshot } from "@yadaw/contracts"
import TempoTrackLane from "./TempoTrackLane.vue"

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [
    { tick: 0, beatsPerMinute: 120 },
    { tick: 3_840, beatsPerMinute: 140 }
  ],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

describe("TempoTrackLane", () => {
  it("removes a selected tempo change without changing the time-signature map", async () => {
    const wrapper = mount(TempoTrackLane, {
      props: {
        tempoMap,
        selectedTick: 3_840,
        contentWidth: 800,
        pixelsPerQuarter: 50,
        height: 112,
        expanded: true
      }
    })

    await wrapper.get('[role="application"]').trigger("keydown", { key: "Delete" })
    const replacement = wrapper.emitted("replace")?.[0]?.[0] as TempoMapSnapshot
    expect(replacement.tempoEvents).toEqual([{ tick: 0, beatsPerMinute: 120 }])
    expect(replacement.timeSignatureEvents).toEqual(tempoMap.timeSignatureEvents)
  })

  it("does not delete the required tick-zero tempo event", async () => {
    const wrapper = mount(TempoTrackLane, {
      props: {
        tempoMap,
        selectedTick: 0,
        contentWidth: 800,
        pixelsPerQuarter: 50,
        height: 112,
        expanded: true
      }
    })

    await wrapper.get('[role="application"]').trigger("keydown", { key: "Delete" })
    expect(wrapper.emitted("replace")).toBeUndefined()
  })
})
