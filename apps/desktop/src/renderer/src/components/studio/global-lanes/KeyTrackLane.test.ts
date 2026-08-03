import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { KeySignatureEventState, TempoMapSnapshot } from "@heron/contracts"
import KeyTrackLane from "./KeyTrackLane.vue"

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}
const events: KeySignatureEventState[] = [
  { tick: 0, fifths: 0, mode: "major" },
  { tick: 3_840, fifths: -7, mode: "minor" }
]

describe("KeyTrackLane", () => {
  it("renders key segments and removes a selected key change", async () => {
    const wrapper = mount(KeyTrackLane, {
      props: {
        events,
        tempoMap,
        selectedTick: 3_840,
        contentWidth: 800,
        pixelsPerQuarter: 50,
        height: 64
      }
    })

    expect(wrapper.text()).toContain("C Major")
    expect(wrapper.text()).toContain("A♭ minor")
    await wrapper.get('[role="application"]').trigger("keydown", { key: "Delete" })
    expect(wrapper.emitted("replace")?.[0]?.[0]).toEqual([{ tick: 0, fifths: 0, mode: "major" }])
  })

  it("keeps the required tick-zero key event", async () => {
    const wrapper = mount(KeyTrackLane, {
      props: {
        events,
        tempoMap,
        selectedTick: 0,
        contentWidth: 800,
        pixelsPerQuarter: 50,
        height: 64
      }
    })

    await wrapper.get('[role="application"]').trigger("keydown", { key: "Backspace" })
    expect(wrapper.emitted("replace")).toBeUndefined()
  })
})
