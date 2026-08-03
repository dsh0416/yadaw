import { describe, expect, it, vi } from "vitest"
import type { MidiClipState } from "@heron/contracts"
import { useMidiClipTrim } from "./useMidiClipTrim"

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

function pointerEvent(
  type: string,
  overrides: Partial<PointerEvent> & { clientX: number; pointerId?: number }
): PointerEvent {
  const target = document.createElement("span")
  target.setPointerCapture = vi.fn()
  return {
    type,
    pointerId: overrides.pointerId ?? 1,
    clientX: overrides.clientX,
    currentTarget: target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as PointerEvent
}

describe("useMidiClipTrim", () => {
  it("converts pointer deltas with the project ticks-per-quarter", () => {
    const commit = vi.fn()
    const trim = useMidiClipTrim({
      clip: () => clip,
      pixelsPerQuarter: () => 480,
      ticksPerQuarter: () => 1_920,
      snap: () => "off",
      commit
    })

    // 480 px/quarter at 1920 TPQ => 0.25 px/tick. A +120px drag is +480 ticks.
    trim.start(pointerEvent("pointerdown", { clientX: 100 }), "end")
    trim.update(pointerEvent("pointermove", { clientX: 220 }))
    expect(trim.preview.value).toMatchObject({ startTick: 960, lengthTicks: 1_440 })
    trim.finish(pointerEvent("pointerup", { clientX: 220 }))

    expect(commit).toHaveBeenCalledWith("end", 2_400)
    expect(trim.preview.value).toBeNull()
  })

  it("ignores mismatched pointer ids and cancels an in-flight preview", () => {
    const commit = vi.fn()
    const trim = useMidiClipTrim({
      clip: () => clip,
      pixelsPerQuarter: () => 480,
      ticksPerQuarter: () => 960,
      snap: () => "1/16",
      commit
    })

    trim.start(pointerEvent("pointerdown", { clientX: 100, pointerId: 3 }), "start")
    trim.update(pointerEvent("pointermove", { clientX: 220, pointerId: 9 }))
    expect(trim.preview.value).toEqual(clip)
    trim.cancel()
    trim.finish(pointerEvent("pointerup", { clientX: 220, pointerId: 3 }))

    expect(commit).not.toHaveBeenCalled()
    expect(trim.active.value).toBeNull()
  })
})
