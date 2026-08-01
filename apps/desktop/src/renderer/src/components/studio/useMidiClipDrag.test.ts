import { shallowRef } from "vue"
import { describe, expect, it, vi } from "vitest"
import type { MidiClipState, TempoMapSnapshot } from "@yadaw/contracts"
import type { PianoRollSnap } from "../../utils/pianoRoll"
import { useMidiClipDrag } from "./useMidiClipDrag"

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
  startTick: 0,
  lengthTicks: 960,
  sourceOffsetTicks: 0,
  sourceLengthTicks: Number.MAX_SAFE_INTEGER,
  notes: [],
  events: []
}

describe("useMidiClipDrag", () => {
  it("previews snapped position and target track before committing once on drop", () => {
    const content = document.createElement("div")
    const firstLane = document.createElement("div")
    firstLane.dataset.trackId = "instrument-1"
    firstLane.dataset.trackKind = "instrument"
    const secondLane = document.createElement("div")
    secondLane.dataset.trackId = "instrument-2"
    secondLane.dataset.trackKind = "instrument"
    content.append(firstLane, secondLane)
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 0,
      top: 0,
      right: 1_300,
      bottom: 200,
      left: 100,
      width: 1_200,
      height: 200,
      toJSON: () => ({})
    })
    vi.spyOn(firstLane, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 0,
      top: 0,
      right: 1_300,
      bottom: 100,
      left: 100,
      width: 1_200,
      height: 100,
      toJSON: () => ({})
    })
    vi.spyOn(secondLane, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      top: 100,
      right: 1_300,
      bottom: 200,
      left: 100,
      width: 1_200,
      height: 100,
      toJSON: () => ({})
    })
    const moveClip = vi.fn()
    const drag = useMidiClipDrag({
      clips: shallowRef([clip]),
      content: shallowRef(content),
      tempoMap: () => tempoMap,
      pixelsPerQuarter: shallowRef(120),
      snap: shallowRef<PianoRollSnap>("1/16"),
      moveClip
    })
    const event = {
      clientX: 245,
      clientY: 150,
      preventDefault: vi.fn(),
      dataTransfer: null
    } as unknown as DragEvent

    drag.handleMidiClipDragStart("clip-1", 20)
    drag.updateMidiClipDrag(event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(drag.midiDragPreview.value).toMatchObject({
      id: "clip-1",
      trackId: "instrument-2",
      startTick: 960
    })
    expect(moveClip).not.toHaveBeenCalled()

    drag.handleMidiClipDrop(event)
    expect(moveClip).toHaveBeenCalledOnce()
    expect(moveClip).toHaveBeenCalledWith("clip-1", "instrument-2", 960)
    expect(drag.midiDragPreview.value).toBeNull()
  })
})
