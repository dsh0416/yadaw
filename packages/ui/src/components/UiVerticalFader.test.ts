import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"

import UiVerticalFader from "./UiVerticalFader.vue"

const props = {
  value: 0,
  min: -90,
  max: 12,
  step: 0.1,
  defaultValue: 0,
  label: "Vocal volume",
  valueText: (value: number) => (value <= -90 ? "−∞" : `${value.toFixed(1)} dB`),
  marks: [
    { value: 0, label: "0", position: 12, emphasis: true },
    { value: -90, label: "−∞", position: 100 }
  ]
}

describe("UiVerticalFader", () => {
  it("does not jump when the user clicks away from the thumb", () => {
    const wrapper = mount(UiVerticalFader, { props })
    const input = wrapper.get('input[type="range"]')
    Object.defineProperty(input.element, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 100 })
    })

    const trackPointer = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientY: 80
    })
    expect(input.element.dispatchEvent(trackPointer)).toBe(false)

    const thumbPointer = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientY: 18
    })
    expect(input.element.dispatchEvent(thumbPointer)).toBe(true)
  })

  it("previews, commits, cancels, and resets a Logic-style gesture", async () => {
    const wrapper = mount(UiVerticalFader, { props })
    const input = wrapper.get('input[type="range"]')

    await input.setValue("-6")
    expect(wrapper.emitted("preview")?.at(-1)).toEqual([-6])
    expect(wrapper.emitted("commit")?.at(-1)).toEqual([-6])

    const commitsBeforeCancel = wrapper.emitted("commit")?.length ?? 0
    await input.trigger("pointerdown")
    ;(input.element as HTMLInputElement).value = "-18"
    await input.trigger("input")
    await input.trigger("keydown", { key: "Escape" })
    await input.trigger("change")
    expect(wrapper.emitted("preview")?.at(-1)).toEqual([0])
    expect(wrapper.emitted("commit")).toHaveLength(commitsBeforeCancel)

    await input.trigger("dblclick")
    expect(wrapper.emitted("commit")?.at(-1)).toEqual([0])
    expect(input.attributes("aria-valuetext")).toBe("0.0 dB")

    await input.trigger("pointerdown")
    ;(input.element as HTMLInputElement).value = "-12"
    await input.trigger("input")
    await input.trigger("pointercancel")
    expect(wrapper.emitted("preview")?.at(-1)).toEqual([0])
  })
})
