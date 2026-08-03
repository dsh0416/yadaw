import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import AudioBackendSection from "./AudioBackendSection.vue"

describe("AudioBackendSection", () => {
  it("shows the ASIO compatibility notice wherever ASIO can be enabled", () => {
    const wrapper = mount(AudioBackendSection, {
      props: {
        modelValue: "wasapi",
        options: [
          { value: "wasapi", label: "WASAPI" },
          { value: "asio", label: "ASIO®" }
        ],
        optionCount: 2,
        discoveryState: "ready"
      }
    })

    expect(wrapper.find(".asio-configuration-notice").exists()).toBe(true)
    expect(wrapper.text()).toContain("ASIO® compatibility")
    expect(wrapper.text()).toContain(
      "ASIO is a registered trademark of Steinberg Media Technologies GmbH."
    )
  })

  it("omits the notice when the current build cannot offer ASIO", () => {
    const wrapper = mount(AudioBackendSection, {
      props: {
        modelValue: "coreaudio",
        options: [{ value: "coreaudio", label: "CoreAudio" }],
        optionCount: 1,
        discoveryState: "ready"
      }
    })

    expect(wrapper.find(".asio-configuration-notice").exists()).toBe(false)
  })
})
