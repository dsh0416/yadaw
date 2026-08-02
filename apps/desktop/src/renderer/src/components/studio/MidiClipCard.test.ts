import { afterEach, describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { MidiClipState } from "@yadaw/contracts"
import MidiClipCard from "./MidiClipCard.vue"

const clip: MidiClipState = {
  id: "clip-1",
  sourceId: "source-1",
  trackId: "track-1",
  name: "Verse",
  startTick: 960,
  sourceOffsetTicks: 0,
  lengthTicks: 960,
  sourceLengthTicks: 1_920,
  notes: [],
  events: []
}

function mountCard() {
  return mount(MidiClipCard, {
    props: {
      clip,
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
        timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
      },
      pixelsPerQuarter: 480,
      trackColor: "#73d6a2",
      selectedClipIds: [],
      playheadTick: 1_440,
      snap: "1/16",
      dragging: false
    },
    attachTo: document.body
  })
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("MidiClipCard", () => {
  it("previews a snapped edge drag and emits one trim commit on release", async () => {
    const wrapper = mountCard()
    const handle = wrapper.get('[data-testid="midi-trim-start"]')

    await handle.trigger("pointerdown", { pointerId: 7, clientX: 100 })
    await handle.trigger("pointermove", { pointerId: 7, clientX: 220 })
    expect(wrapper.get('[role="button"]').attributes("style")).toContain("left: 600px")
    await handle.trigger("pointerup", { pointerId: 7, clientX: 220 })

    expect(wrapper.emitted("trim")).toEqual([["clip-1", "start", 1_200]])
  })

  it("selects an unselected target before opening its context commands", async () => {
    const wrapper = mountCard()

    await wrapper.get('[role="button"]').trigger("contextmenu")

    expect(wrapper.emitted("select")).toEqual([["clip-1", false]])
    expect(document.body.textContent).toContain("Split at playhead")
    expect(document.body.textContent).toContain("Trim start to playhead")
  })
})
