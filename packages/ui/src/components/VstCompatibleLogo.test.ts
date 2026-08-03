import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import VstCompatibleLogo from "./VstCompatibleLogo.vue"

describe("VstCompatibleLogo", () => {
  it("uses the official dark-surface artwork by default", () => {
    const wrapper = mount(VstCompatibleLogo)

    expect(wrapper.attributes("data-appearance")).toBe("on-dark")
    expect(wrapper.attributes("alt")).toBe("VST Compatible")
    expect(wrapper.attributes("src")).toContain("VST_Compatible_Logo_Steinberg")
  })

  it("switches to the official light-surface artwork", async () => {
    const wrapper = mount(VstCompatibleLogo)
    const darkSource = wrapper.attributes("src")

    await wrapper.setProps({ appearance: "on-light" })

    expect(wrapper.attributes("data-appearance")).toBe("on-light")
    expect(wrapper.attributes("src")).not.toBe(darkSource)
    expect(wrapper.attributes("src")).toContain("negative")
  })

  it("can be decorative when adjacent copy identifies the trademark", () => {
    const wrapper = mount(VstCompatibleLogo, { props: { decorative: true } })

    expect(wrapper.attributes("alt")).toBe("")
    expect(wrapper.attributes("aria-hidden")).toBe("true")
  })
})
