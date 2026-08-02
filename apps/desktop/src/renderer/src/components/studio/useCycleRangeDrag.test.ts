import { afterEach, describe, expect, it, vi } from "vitest"
import type { TempoMapSnapshot, TransportLoopRange } from "@yadaw/contracts"
import { useCycleRangeDrag } from "./useCycleRangeDrag"

afterEach(() => {
  document.body.innerHTML = ""
})

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

function laneTarget(): HTMLElement {
  const lane = document.createElement("div")
  lane.className = "cycle-lane"
  lane.setPointerCapture = vi.fn()
  document.body.append(lane)
  vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 2_000,
    bottom: 16,
    left: 0,
    width: 2_000,
    height: 16,
    toJSON: () => ({})
  })
  return lane
}

function pointerEvent(
  type: string,
  target: HTMLElement,
  overrides: Partial<PointerEvent> & { clientX: number; pointerId?: number }
): PointerEvent {
  return {
    type,
    pointerId: overrides.pointerId ?? 1,
    clientX: overrides.clientX,
    currentTarget: target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as PointerEvent
}

describe("useCycleRangeDrag", () => {
  it("creates a beat-snapped cycle range from an empty lane drag", () => {
    const commit = vi.fn()
    const drag = useCycleRangeDrag({
      range: () => null,
      tempoMap: () => tempoMap,
      pixelsPerQuarter: () => 480,
      commit
    })
    const lane = laneTarget()

    drag.start(pointerEvent("pointerdown", lane, { clientX: 480 }), "create")
    drag.update(pointerEvent("pointermove", lane, { clientX: 1_440 }))
    expect(drag.preview.value).toEqual({ startTick: 960, endTick: 2_880 })
    drag.finish(pointerEvent("pointerup", lane, { clientX: 1_440 }))

    expect(commit).toHaveBeenCalledWith({ startTick: 960, endTick: 2_880 })
    expect(drag.active.value).toBe(false)
  })

  it("moves and resizes an existing range before committing", () => {
    const range: TransportLoopRange = { startTick: 960, endTick: 2_880 }
    const commit = vi.fn()
    const drag = useCycleRangeDrag({
      range: () => range,
      tempoMap: () => tempoMap,
      pixelsPerQuarter: () => 480,
      commit
    })
    const lane = laneTarget()
    const edge = document.createElement("i")
    edge.className = "cycle-edge"
    lane.append(edge)
    edge.setPointerCapture = vi.fn()

    drag.start(pointerEvent("pointerdown", edge, { clientX: 480 }), "move")
    drag.update(pointerEvent("pointermove", edge, { clientX: 960 }))
    expect(drag.preview.value).toEqual({ startTick: 1_920, endTick: 3_840 })
    drag.finish(pointerEvent("pointerup", edge, { clientX: 960 }))
    expect(commit).toHaveBeenCalledWith({ startTick: 1_920, endTick: 3_840 })

    drag.start(pointerEvent("pointerdown", edge, { clientX: 480 }), "resize-end")
    drag.update(pointerEvent("pointermove", edge, { clientX: 1_920 }))
    expect(drag.preview.value).toEqual({ startTick: 960, endTick: 3_840 })
    drag.cancel()
    expect(drag.preview.value).toBeNull()
    expect(drag.active.value).toBe(false)
  })

  it("ignores gestures that are outside the cycle lane", () => {
    const drag = useCycleRangeDrag({
      range: () => null,
      tempoMap: () => tempoMap,
      pixelsPerQuarter: () => 480,
      commit: vi.fn()
    })
    const orphan = document.createElement("div")

    drag.start(pointerEvent("pointerdown", orphan, { clientX: 100 }), "create")

    expect(drag.active.value).toBe(false)
    expect(drag.preview.value).toBeNull()
  })
})
