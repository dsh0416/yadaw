import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { MixerChannelState } from "@yadaw/contracts"
import MixerChannelStrip from "./MixerChannelStrip.vue"

const channel: MixerChannelState = {
  id: "audio",
  kind: "audio",
  name: "Vocal",
  color: "#8C83FF",
  sortOrder: 0,
  channelFormat: "mono",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "master",
  recordArmed: false,
  inputChannels: [1]
}

describe("MixerChannelStrip", () => {
  it("exposes accessible controls and emits preview/commit gestures", async () => {
    const wrapper = mount(MixerChannelStrip, {
      props: {
        channel,
        sends: [],
        meter: {
          channelId: "audio",
          preFaderPeak: [0.25, 0.25],
          postFaderPeak: [0.5, 0.5],
          heldPeak: [0.75, 0.75],
          clipped: false
        },
        outputs: [{
          ...channel,
          id: "master",
          kind: "master",
          name: "Master",
          channelFormat: "stereo",
          outputChannelId: null,
          inputChannels: []
        }],
        selected: false,
        density: "full"
      }
    })

    const volume = wrapper.get('input[aria-label="Vocal volume"]')
    await volume.setValue("-6")
    await volume.trigger("change")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "channel", id: "audio", parameter: "gainDb", value: -6
    })
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { gainDb: -6 }])

    const commitsBeforeCancel = wrapper.emitted("updateChannel")?.length ?? 0
    await volume.trigger("pointerdown")
    ;(volume.element as HTMLInputElement).value = "-18"
    await volume.trigger("input")
    await volume.trigger("keydown", { key: "Escape" })
    await volume.trigger("change")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({ value: 0 })
    expect(wrapper.emitted("updateChannel")?.length).toBe(commitsBeforeCancel)

    await volume.trigger("dblclick")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { gainDb: 0 }])

    await wrapper.get('input[aria-label="Vocal volume value in decibels"]').setValue("-3.5")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { gainDb: -3.5 }])

    await wrapper.get('button[aria-label="Mute Vocal"]').trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { muted: true }])
    expect(wrapper.get('button[aria-label="Arm Vocal"]').attributes("aria-pressed")).toBe("false")
  })
})
