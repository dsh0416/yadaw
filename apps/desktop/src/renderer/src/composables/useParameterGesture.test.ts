import { describe, expect, it, vi } from "vitest"
import { useParameterGesture } from "./useParameterGesture"

function inputEvent(value: string): Event {
  const input = document.createElement("input")
  input.value = value
  return { currentTarget: input } as unknown as Event
}

describe("useParameterGesture", () => {
  it("previews while dragging and commits the final value", () => {
    const preview = vi.fn()
    const commit = vi.fn()
    const gesture = useParameterGesture({
      currentValue: () => 10,
      preview,
      commit
    })

    gesture.preview(inputEvent("12"))
    expect(preview).toHaveBeenCalledWith(12)
    gesture.commit(inputEvent("14"))
    expect(commit).toHaveBeenCalledWith(14)
  })

  it("cancels with Escape and restores the start value on commit", () => {
    const preview = vi.fn()
    const commit = vi.fn()
    const gesture = useParameterGesture({
      currentValue: () => 5,
      preview,
      commit
    })
    const input = document.createElement("input")
    input.value = "9"
    gesture.preview({ currentTarget: input } as unknown as Event)

    const keydown = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    Object.defineProperty(keydown, "currentTarget", { value: input })
    gesture.keydown(keydown)
    expect(preview).toHaveBeenLastCalledWith(5)
    expect(input.value).toBe("5")

    gesture.commit({ currentTarget: input } as unknown as Event)
    expect(commit).not.toHaveBeenCalled()
    expect(input.value).toBe("5")
  })

  it("resets directly to a committed value", () => {
    const preview = vi.fn()
    const commit = vi.fn()
    const gesture = useParameterGesture({
      currentValue: () => 1,
      preview,
      commit
    })
    gesture.begin()
    gesture.reset(0)
    expect(commit).toHaveBeenCalledWith(0)
  })
})
