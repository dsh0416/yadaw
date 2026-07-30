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
        keyboardInsertionTick: 1_920,
        dragPreview: null,
        draggingClipId: null
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
        keyboardInsertionTick: 1_920,
        dragPreview: null,
        draggingClipId: null
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

  it("renders a live snapped drag preview and fades the source clip", async () => {
    const preview = { ...clip, trackId: "instrument-2", startTick: 1_920 }
    const wrapper = mount(MidiArrangementTrack, {
      props: {
        trackId: "instrument-2",
        trackColor: "#67D9E7",
        clips: [clip],
        tempoMap,
        contentWidth: 1_200,
        pixelsPerQuarter: 120,
        trackHeight: 80,
        selectedClipIds: [],
        keyboardInsertionTick: 0,
        dragPreview: preview,
        draggingClipId: "clip-1"
      }
    })

    expect(wrapper.get(".midi-clip").classes()).toContain("dragging")
    expect(
      wrapper.get<HTMLElement>('[data-testid="midi-clip-drop-preview"]').element.style.left
    ).toBe("240px")
    expect(
      wrapper.get<HTMLElement>('[data-testid="midi-clip-drop-preview"]').element.style.width
    ).toBe("120px")
  })
})
