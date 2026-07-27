import { mount } from "@vue/test-utils"
import { afterEach, describe, expect, it } from "vitest"
import { UiCascadingSelect } from "@yadaw/ui"
import MixerInputCapsule from "./MixerInputCapsule.vue"

afterEach(() => {
  document.body.innerHTML = ""
})

describe("MixerInputCapsule", () => {
  it("pairs an even mono input with its preceding neighbor when stereo is enabled", async () => {
    const wrapper = mount(MixerInputCapsule, {
      attachTo: document.body,
      props: {
        channelName: "Audio 1",
        inputSource: "hardware",
        inputFormat: "mono",
        inputChannels: [2]
      }
    })

    const select = wrapper.get('button[aria-label="Audio 1 input channel"]')
    expect(select.text()).toBe("IN 2")
    const routeMenu = wrapper.getComponent(UiCascadingSelect)
    expect(routeMenu.props("groups")?.map((group) => group.options.length)).toEqual([32, 256])

    const stereoButton = wrapper.get(
      'button[aria-label="Link adjacent input as stereo for Audio 1"]'
    )
    expect(stereoButton.attributes("aria-pressed")).toBe("false")
    expect(stereoButton.get('[role="img"]').attributes("aria-label")).toBe("1 channel audio")
    expect(stereoButton.findAll("path")).toHaveLength(1)
    await stereoButton.trigger("click")

    expect(wrapper.emitted("update")).toEqual([
      [{ inputSource: "hardware", inputFormat: "stereo", inputChannels: [1, 2] }]
    ])
  })

  it("offers canonical stereo pairs and emits both routed channels", async () => {
    const wrapper = mount(MixerInputCapsule, {
      attachTo: document.body,
      props: {
        channelName: "Audio 2",
        inputSource: "hardware",
        inputFormat: "stereo",
        inputChannels: [3, 4]
      }
    })

    const select = wrapper.get('button[aria-label="Audio 2 input channel"]')
    expect(select.text()).toBe("IN 3–4")
    const formatButton = wrapper.get('button[aria-label="Use mono input for Audio 2"]')
    expect(formatButton.get('[role="img"]').attributes("aria-label")).toBe("2 channels audio")
    expect(formatButton.findAll("path")).toHaveLength(2)
    const routeMenu = wrapper.getComponent(UiCascadingSelect)
    expect(routeMenu.props("groups")?.map((group) => group.options.length)).toEqual([16, 128])
    routeMenu.vm.$emit("update:modelValue", "hardware:5")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("update")).toEqual([
      [{ inputSource: "hardware", inputFormat: "stereo", inputChannels: [5, 6] }]
    ])
  })

  it("switches an audio channel from hardware input to a fixed BUS slot", async () => {
    const wrapper = mount(MixerInputCapsule, {
      props: {
        channelName: "Audio 3",
        inputSource: "hardware",
        inputFormat: "mono",
        inputChannels: [1]
      }
    })

    wrapper.getComponent(UiCascadingSelect).vm.$emit("update:modelValue", "bus:256")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("update")).toEqual([
      [{ inputSource: "bus", inputFormat: "mono", inputChannels: [256] }]
    ])
  })
})
