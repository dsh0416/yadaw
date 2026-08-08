import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"

import UiMixerStateButton from "./UiMixerStateButton.vue"

describe("UiMixerStateButton", () => {
  it("keeps pressed semantics separate from the effective active state", async () => {
    const wrapper = mount(UiMixerStateButton, {
      props: {
        label: "Monitor Vocal",
        tone: "input",
        size: "narrow",
        joined: "end",
        pressed: true,
        active: false,
        disabled: true
      },
      slots: { default: "I" }
    })

    const button = wrapper.get("button")
    expect(button.attributes("aria-label")).toBe("Monitor Vocal")
    expect(button.attributes("aria-pressed")).toBe("true")
    expect(button.classes()).toEqual(
      expect.arrayContaining(["tone-input", "size-narrow", "joined-end"])
    )
    expect(button.classes()).not.toContain("active")
    expect(button.attributes()).toHaveProperty("disabled")

    await button.trigger("click")
    expect(wrapper.emitted("click")).toBeUndefined()
  })
})
