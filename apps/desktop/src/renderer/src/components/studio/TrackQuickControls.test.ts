import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import type { MixerChannelState } from "@heron/contracts"
import TrackQuickControls from "./TrackQuickControls.vue"

const channel: MixerChannelState = {
  id: "audio",
  kind: "audio",
  systemRole: null,
  name: "Vocal",
  color: "#8C83FF",
  sortOrder: 0,
  inputSource: "hardware",
  inputFormat: "mono",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

describe("TrackQuickControls", () => {
  it("provides mixer actions, metered gain, and pan gestures", async () => {
    const wrapper = mount(TrackQuickControls, {
      props: {
        channel,
        meter: {
          channelId: "audio",
          preFaderPeak: [0.5, 0.5],
          postFaderPeak: [0.5, 0.5],
          heldPeak: [0.5, 0.5],
          clipped: false
        }
      },
      global: { plugins: [createPinia()] }
    })

    await wrapper.get('button[aria-label="Mute Vocal"]').trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { muted: true }])
    await wrapper.get('button[aria-label="Solo Vocal"]').trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { soloed: true }])
    await wrapper.get('button[aria-label="Arm Vocal"]').trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { recordArmed: true }])
    const monitor = wrapper.get('button[aria-label="Monitor Vocal"]')
    expect(monitor.attributes("disabled")).toBeUndefined()
    await monitor.trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { inputMonitoring: true }])

    const gain = wrapper.get('input[aria-label="Vocal quick volume"]')
    await gain.trigger("pointerdown")
    ;(gain.element as HTMLInputElement).value = "-3"
    await gain.trigger("input")
    expect(wrapper.find(".parameter-tooltip").exists()).toBe(true)
    await gain.trigger("change")
    await gain.setValue("-6")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "channel",
      id: "audio",
      parameter: "gainDb",
      value: -6
    })
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { gainDb: -6 }])
    expect(wrapper.get(".track-gain").attributes("style")).toContain("--meter-level:")

    const pan = wrapper.get('input[aria-label="Vocal quick pan"]')
    expect(wrapper.find(".track-pan output").exists()).toBe(false)
    await pan.setValue("-32")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "channel",
      id: "audio",
      parameter: "pan",
      value: -0.5
    })
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { pan: -0.5 }])

    await pan.trigger("pointerdown", { button: 0, pointerId: 7, clientY: 100 })
    await pan.trigger("pointermove", { pointerId: 7, clientY: 80 })
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "channel",
      id: "audio",
      parameter: "pan",
      value: 10 / 63
    })
    await pan.trigger("pointerup", { pointerId: 7, clientY: 80 })
    expect(wrapper.emitted("updateChannel")?.at(-1)?.[1]).toMatchObject({
      pan: 10 / 63
    })

    await pan.trigger("dblclick")
    const panEditor = wrapper.get('input[aria-label="Vocal quick pan value"]')
    await panEditor.setValue("32")
    await panEditor.trigger("blur")
    expect(wrapper.emitted("updateChannel")?.at(-1)?.[0]).toBe("audio")
    expect(wrapper.emitted("updateChannel")?.at(-1)?.[1]).toMatchObject({
      pan: 32 / 63
    })
  })
})
