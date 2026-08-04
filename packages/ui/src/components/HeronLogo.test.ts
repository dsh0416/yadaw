import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import HeronLogo from "./HeronLogo.vue"

describe("HeronLogo", () => {
  it("uses the canonical lockup by default", () => {
    const wrapper = mount(HeronLogo)

    expect(wrapper.attributes("role")).toBe("img")
    expect(wrapper.attributes("aria-label")).toBe("Heron")
    expect(wrapper.get("img").attributes("src")).toContain("heron-logo.png")
    expect(wrapper.get("img").attributes("alt")).toBe("")
    expect(wrapper.text()).toBe("Heron")
  })

  it("supports the official mark and wordmark variants", async () => {
    const wrapper = mount(HeronLogo, { props: { variant: "mark" } })

    expect(wrapper.find("img").exists()).toBe(true)
    expect(wrapper.text()).toBe("")

    await wrapper.setProps({ variant: "wordmark" })

    expect(wrapper.find("img").exists()).toBe(false)
    expect(wrapper.text()).toBe("Heron")
  })

  it("can be decorative when another accessible brand label is present", () => {
    const wrapper = mount(HeronLogo, { props: { decorative: true } })

    expect(wrapper.attributes("aria-hidden")).toBe("true")
    expect(wrapper.attributes("role")).toBeUndefined()
    expect(wrapper.attributes("aria-label")).toBeUndefined()
  })
})
