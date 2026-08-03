import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { MixerChannelState } from "@heron/contracts"
import MixerInputSection from "./MixerInputSection.vue"

const channel: MixerChannelState = {
  id: "audio",
  kind: "audio",
  systemRole: null,
  name: "Audio 1",
  color: "#4F8CFF",
  sortOrder: 0,
  inputSource: "hardware",
  inputFormat: "stereo",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1, 2],
  hardwareOutputChannels: []
}

describe("MixerInputSection", () => {
  it("renders the audio input capsule and forwards its complete routing patch", async () => {
    const wrapper = mount(MixerInputSection, {
      props: {
        channel,
        instrument: null,
        pluginRuntime: {},
        instrumentPlugins: []
      }
    })

    const select = wrapper.get('button[aria-label="Audio 1 input channel"]')
    expect(select.text()).toBe("IN 1–2")

    const stereoButton = wrapper.get('button[aria-label="Use mono input for Audio 1"]')
    expect(stereoButton.attributes("aria-pressed")).toBe("true")
    await stereoButton.trigger("click")

    expect(wrapper.emitted("updateChannel")).toEqual([
      [{ inputSource: "hardware", inputFormat: "mono", inputChannels: [1] }]
    ])
  })
})
