import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import HeronLogo from "./HeronLogo.vue"

describe("HeronLogo", () => {
  it("uses the canonical lockup by default", () => {
    const wrapper = mount(HeronLogo)

    expect(wrapper.attributes("role")).toBe("img")
    expect(wrapper.attributes("aria-label")).toBe("YADAW")
    expect(wrapper.get("svg").findAll("rect")).toHaveLength(5)
    expect(wrapper.text()).toBe("YADAW")
  })

  it("supports the official mark and wordmark variants", async () => {
    const wrapper = mount(HeronLogo, { props: { variant: "mark" } })

    expect(wrapper.find("svg").exists()).toBe(true)
    expect(wrapper.text()).toBe("")

    await wrapper.setProps({ variant: "wordmark" })

    expect(wrapper.find("svg").exists()).toBe(false)
    expect(wrapper.text()).toBe("YADAW")
  })

  it("can be decorative when another accessible brand label is present", () => {
    const wrapper = mount(HeronLogo, { props: { decorative: true } })

    expect(wrapper.attributes("aria-hidden")).toBe("true")
    expect(wrapper.attributes("role")).toBeUndefined()
    expect(wrapper.attributes("aria-label")).toBeUndefined()
  })
})
