import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import AsioCompatibleLogo from "./AsioCompatibleLogo.vue"

describe("AsioCompatibleLogo", () => {
  it("uses the official ASIO Compatible artwork", () => {
    const wrapper = mount(AsioCompatibleLogo)

    expect(wrapper.attributes("alt")).toBe("ASIO Compatible")
    expect(wrapper.attributes("src")).toMatch(/^data:image\/svg\+xml,/)
    expect(wrapper.attributes("src")).toContain("112.77%2071.85")
  })

  it("can be decorative when adjacent copy identifies the trademark", () => {
    const wrapper = mount(AsioCompatibleLogo, { props: { decorative: true } })

    expect(wrapper.attributes("alt")).toBe("")
    expect(wrapper.attributes("aria-hidden")).toBe("true")
  })
})
