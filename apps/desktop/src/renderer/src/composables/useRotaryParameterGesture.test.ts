import { describe, expect, it, vi } from "vitest"
import { useRotaryParameterGesture } from "./useRotaryParameterGesture"

function pointer(
  type: string,
  options: { clientY: number; pointerId?: number; button?: number },
  target: HTMLElement
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY: options.clientY,
    pointerId: options.pointerId ?? 1,
    button: options.button ?? 0
  })
  Object.defineProperty(event, "currentTarget", { value: target })
  return event
}

describe("useRotaryParameterGesture", () => {
  it("drags vertically to preview stepped values and commits on release", () => {
    const preview = vi.fn()
    const commit = vi.fn()
    const target = document.createElement("button")
    target.setPointerCapture = vi.fn()
    target.releasePointerCapture = vi.fn()
    const gesture = useRotaryParameterGesture({
      currentValue: () => 10,
      minimum: 0,
      maximum: 20,
      pixelsPerStep: 2,
      preview,
      commit
    })

    gesture.begin(pointer("pointerdown", { clientY: 100 }, target))
    expect(gesture.dragging.value).toBe(true)
    gesture.move(pointer("pointermove", { clientY: 90 }, target))
    expect(preview).toHaveBeenCalledWith(15)
    expect(gesture.dragValue.value).toBe(15)

    gesture.end(pointer("pointerup", { clientY: 90 }, target))
    expect(commit).toHaveBeenCalledWith(15)
    expect(gesture.dragging.value).toBe(false)
  })

  it("cancels back to the start value and ignores non-primary buttons", () => {
    const preview = vi.fn()
    const commit = vi.fn()
    const target = document.createElement("button")
    target.setPointerCapture = vi.fn()
    target.releasePointerCapture = vi.fn()
    const gesture = useRotaryParameterGesture({
      currentValue: () => 4,
      minimum: 0,
      maximum: 10,
      preview,
      commit
    })

    gesture.begin(pointer("pointerdown", { clientY: 50, button: 2 }, target))
    expect(gesture.dragging.value).toBe(false)

    gesture.begin(pointer("pointerdown", { clientY: 50 }, target))
    gesture.move(pointer("pointermove", { clientY: 40 }, target))
    gesture.cancel(pointer("pointercancel", { clientY: 40 }, target))
    expect(preview).toHaveBeenLastCalledWith(4)
    expect(gesture.dragValue.value).toBe(4)
    expect(commit).not.toHaveBeenCalled()
  })

  it("clamps dragged values to the configured range", () => {
    const preview = vi.fn()
    const target = document.createElement("button")
    target.setPointerCapture = vi.fn()
    const gesture = useRotaryParameterGesture({
      currentValue: () => 2,
      minimum: 0,
      maximum: 5,
      pixelsPerStep: 1,
      preview,
      commit: vi.fn()
    })
    gesture.begin(pointer("pointerdown", { clientY: 100 }, target))
    gesture.move(pointer("pointermove", { clientY: 200 }, target))
    expect(preview).toHaveBeenCalledWith(0)
    gesture.move(pointer("pointermove", { clientY: 0 }, target))
    expect(preview).toHaveBeenCalledWith(5)
  })
})
