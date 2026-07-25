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
    Object.defineProperty(volume.element, "getBoundingClientRect", {
      value: () => ({
        top: 0,
        right: 20,
        bottom: 100,
        left: 0,
        width: 20,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    })
    const trackPointer = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientY: 80
    })
    expect(volume.element.dispatchEvent(trackPointer)).toBe(false)
    const thumbPointer = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientY: 18
    })
    expect(volume.element.dispatchEvent(thumbPointer)).toBe(true)

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
    expect(wrapper.get('output[aria-label="Vocal live post-fader level in decibels"]').text()).toBe("-6.0")

    const pan = wrapper.get('input[aria-label="Vocal pan"]')
    await pan.setValue("-32")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "channel", id: "audio", parameter: "pan", value: -0.5
    })
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { pan: -0.5 }])

    await pan.setValue("63")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { pan: 1 }])

    expect(wrapper.find('input[aria-label="Vocal pan value"]').exists()).toBe(false)
    await wrapper.setProps({ channel: { ...channel, pan: 1 } })
    expect(wrapper.get(".pan-readout").text()).toBe("+63")
    await pan.trigger("dblclick")
    const panEditor = wrapper.get('input[aria-label="Vocal pan value"]')
    expect((panEditor.element as HTMLInputElement).value).toBe("63")
    await panEditor.setValue("-64")
    await panEditor.trigger("blur")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { pan: -1 }])

    await wrapper.get('button[aria-label="Mute Vocal"]').trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { muted: true }])
    expect(wrapper.get('button[aria-label="Arm Vocal"]').attributes("aria-pressed")).toBe("false")
    expect(wrapper.get('button[aria-label="Input monitoring unavailable"]').attributes("disabled")).toBeDefined()
    expect(wrapper.find(".pan-heading").exists()).toBe(false)
  })

  it("uses the conventional M/S/R/I action roles", () => {
    const wrapper = mount(MixerChannelStrip, {
      props: {
        channel: {
          ...channel,
          muted: true,
          soloed: true,
          recordArmed: true
        },
        sends: [],
        meter: {
          channelId: "audio",
          preFaderPeak: [0, 0],
          postFaderPeak: [0, 0],
          heldPeak: [0, 0],
          clipped: false
        },
        outputs: [],
        selected: true,
        density: "full"
      }
    })

    expect(wrapper.get('button[aria-label="Mute Vocal"]').classes()).toContain("mute")
    expect(wrapper.get('button[aria-label="Mute Vocal"]').classes()).toContain("active")
    expect(wrapper.get('button[aria-label="Solo Vocal"]').classes()).toContain("solo")
    expect(wrapper.get('button[aria-label="Solo Vocal"]').classes()).toContain("active")
    expect(wrapper.get('button[aria-label="Arm Vocal"]').classes()).toContain("record")
    expect(wrapper.get('button[aria-label="Arm Vocal"]').classes()).toContain("active")
    expect(wrapper.get('button[aria-label="Input monitoring unavailable"]').classes()).toContain("monitor")
    expect(wrapper.get(".input-actions").findAll("button")).toHaveLength(2)
  })
})
