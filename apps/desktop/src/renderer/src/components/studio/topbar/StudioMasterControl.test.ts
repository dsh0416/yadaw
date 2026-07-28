import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import StudioMasterControl from "./StudioMasterControl.vue"

const channel = {
  id: "master",
  kind: "master" as const,
  systemRole: null,
  name: "Master",
  color: "#67D9E7",
  sortOrder: 0,
  inputSource: null,
  inputFormat: null,
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [],
  hardwareOutputChannels: []
}
const meter = {
  channelId: "master",
  preFaderPeak: [0.1, 0.2] as [number, number],
  postFaderPeak: [0.25, 0.5] as [number, number],
  heldPeak: [0.25, 0.5] as [number, number],
  clipped: false
}

function mountMaster(masterChannel: typeof channel | null = channel) {
  return mount(StudioMasterControl, {
    props: {
      channel: masterChannel,
      meter
    }
  })
}

describe("StudioMasterControl", () => {
  it("previews and commits Master gain changes", async () => {
    const wrapper = mountMaster()
    const slider = wrapper.get<HTMLInputElement>('input[aria-label="Master quick volume"]')

    await slider.trigger("pointerdown")
    slider.element.value = "-12"
    await slider.trigger("input")
    await slider.trigger("change")

    expect(wrapper.emitted("preview")).toEqual([
      [{ target: "channel", id: "master", parameter: "gainDb", value: -12 }]
    ])
    expect(wrapper.emitted("updateChannel")).toEqual([["master", { gainDb: -12 }]])
    expect(wrapper.find(".track-gain").exists()).toBe(true)
    expect(wrapper.find(".gain-meter").exists()).toBe(true)
    expect(wrapper.find(".master-meter").exists()).toBe(false)
    expect(wrapper.find(".master-slider").exists()).toBe(false)
  })

  it("restores the gesture start value on Escape without committing", async () => {
    const wrapper = mountMaster()
    const slider = wrapper.get<HTMLInputElement>('input[aria-label="Master quick volume"]')

    await slider.trigger("pointerdown")
    slider.element.value = "-18"
    await slider.trigger("input")
    await slider.trigger("keydown", { key: "Escape" })

    expect(wrapper.emitted("preview")).toEqual([
      [{ target: "channel", id: "master", parameter: "gainDb", value: -18 }],
      [{ target: "channel", id: "master", parameter: "gainDb", value: 0 }]
    ])
    expect(wrapper.emitted("updateChannel")).toBeUndefined()
    expect(slider.element.value).toBe("0")
  })

  it("disables the control when the project has no Master channel", () => {
    const wrapper = mountMaster(null)
    const slider = wrapper.get<HTMLInputElement>("input")

    expect(slider.attributes("disabled")).toBeDefined()
    expect(slider.attributes("aria-label")).toBe("Master quick volume")
  })
})
