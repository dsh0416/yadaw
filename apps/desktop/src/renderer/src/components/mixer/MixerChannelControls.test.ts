import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { MixerChannelState } from "@heron/contracts"
import MixerChannelControls from "./MixerChannelControls.vue"

const channel: MixerChannelState = {
  id: "channel",
  kind: "audio",
  systemRole: null,
  name: "Channel",
  color: "#888",
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

describe("MixerChannelControls", () => {
  it("shows Bnc only for Output channels and emits the typed action", async () => {
    const regular = mount(MixerChannelControls, {
      props: { channel, monitoringAvailable: true, monitoringActive: false }
    })
    expect(regular.find('button[aria-label^="Bounce"]').exists()).toBe(false)

    const output = mount(MixerChannelControls, {
      props: {
        channel: {
          ...channel,
          kind: "output",
          name: "Output 1–2",
          inputSource: null,
          inputFormat: null,
          inputChannels: [],
          hardwareOutputChannels: [1, 2]
        },
        monitoringAvailable: false,
        monitoringActive: false
      }
    })
    const button = output.get('button[aria-label="Bounce Output 1–2"]')
    expect(button.text()).toBe("Bnc")
    await button.trigger("click")
    expect(output.emitted("bounceOutput")).toHaveLength(1)
    expect(output.find('button[aria-label^="Arm"]').exists()).toBe(false)
    expect(output.find('button[aria-label^="Monitor"]').exists()).toBe(false)
  })
})
