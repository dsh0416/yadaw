import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import ChannelFormatIcon from "./ChannelFormatIcon.vue"

describe("ChannelFormatIcon", () => {
  it("draws mono and stereo as one or two waveform lanes without visible text", async () => {
    const wrapper = mount(ChannelFormatIcon, { props: { channels: 1 } })
    expect(wrapper.findAll("path")).toHaveLength(1)
    expect(wrapper.attributes("aria-label")).toBe("1 channel audio")
    expect(wrapper.text()).toBe("")

    await wrapper.setProps({ channels: 2 })
    expect(wrapper.findAll("path")).toHaveLength(2)
    expect(wrapper.attributes("aria-label")).toBe("2 channels audio")
  })

  it("uses a compact multichannel glyph while preserving the real accessible count", () => {
    const wrapper = mount(ChannelFormatIcon, { props: { channels: 8 } })
    expect(wrapper.findAll("path")).toHaveLength(4)
    expect(wrapper.attributes("aria-label")).toBe("8 channels audio")
  })
})
