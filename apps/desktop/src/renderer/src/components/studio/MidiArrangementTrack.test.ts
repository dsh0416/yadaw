import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { MidiClipState, TempoMapSnapshot } from "@yadaw/contracts"
import MidiArrangementTrack from "./MidiArrangementTrack.vue"

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

const clip: MidiClipState = {
  id: "clip-1",
  sourceId: "source-1",
  trackId: "instrument-1",
  name: "Verse",
  startTick: 960,
  lengthTicks: 960,
  sourceOffsetTicks: 0,
  notes: [],
  events: []
}

describe("MidiArrangementTrack", () => {
  it("selects additively and opens a clip from the arrangement", async () => {
    const wrapper = mount(MidiArrangementTrack, {
      props: {
        trackId: "instrument-1",
        trackColor: "#73D6A2",
        clips: [clip],
        tempoMap,
        contentWidth: 1_200,
        pixelsPerQuarter: 120,
        trackHeight: 80,
        selectedClipIds: ["clip-1", "clip-2"],
        keyboardInsertionTick: 1_920
      }
    })
    const renderedClip = wrapper.get('button[aria-label="Verse, MIDI clip"]')

    expect(renderedClip.attributes("aria-pressed")).toBe("true")
    await renderedClip.trigger("mousedown", { detail: 1 })
    await renderedClip.trigger("click", { ctrlKey: true })
    await renderedClip.trigger("dblclick")

    expect(wrapper.emitted("select")).toEqual([["clip-1", true]])
    expect(wrapper.emitted("open")).toEqual([["clip-1", ["clip-1", "clip-2"]]])
  })

  it("requests a new clip at the pointer or keyboard insertion tick", async () => {
    const wrapper = mount(MidiArrangementTrack, {
      props: {
        trackId: "instrument-1",
        trackColor: "#73D6A2",
        clips: [],
        tempoMap,
        contentWidth: 1_200,
        pixelsPerQuarter: 120,
        trackHeight: 80,
        selectedClipIds: [],
        keyboardInsertionTick: 1_920
      }
    })
    const lane = wrapper.get<HTMLElement>(".midi-track")
    expect(lane.text()).toContain("Double-click to create MIDI clip")
    Object.defineProperty(lane.element, "getBoundingClientRect", {
      value: () => ({ left: 20 })
    })

    await lane.trigger("dblclick", { clientX: 140 })
    await lane.trigger("keydown", { key: "Enter" })

    expect(wrapper.emitted("create")).toEqual([
      ["instrument-1", 960],
      ["instrument-1", 1_920]
    ])
  })
})
