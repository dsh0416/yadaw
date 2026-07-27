import { DOMWrapper, mount } from "@vue/test-utils"
import { afterEach, describe, expect, it } from "vitest"
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
        inputFormat: "mono",
        inputChannels: [2]
      }
    })

    const select = wrapper.get('button[aria-label="Audio 1 input channel"]')
    expect(select.text()).toBe("IN 2")
    await select.trigger("click")
    expect(document.body.querySelectorAll(".ui-cascading-select__item")).toHaveLength(32)

    const stereoButton = wrapper.get(
      'button[aria-label="Link adjacent input as stereo for Audio 1"]'
    )
    expect(stereoButton.attributes("aria-pressed")).toBe("false")
    expect(stereoButton.get('[role="img"]').attributes("aria-label")).toBe("1 channel audio")
    expect(stereoButton.findAll("path")).toHaveLength(1)
    await stereoButton.trigger("click")

    expect(wrapper.emitted("update")).toEqual([[{ inputFormat: "stereo", inputChannels: [1, 2] }]])
  })

  it("offers canonical stereo pairs and emits both routed channels", async () => {
    const wrapper = mount(MixerInputCapsule, {
      attachTo: document.body,
      props: {
        channelName: "Audio 2",
        inputFormat: "stereo",
        inputChannels: [3, 4]
      }
    })

    const select = wrapper.get('button[aria-label="Audio 2 input channel"]')
    expect(select.text()).toBe("IN 3–4")
    const formatButton = wrapper.get('button[aria-label="Use mono input for Audio 2"]')
    expect(formatButton.get('[role="img"]').attributes("aria-label")).toBe("2 channels audio")
    expect(formatButton.findAll("path")).toHaveLength(2)
    await select.trigger("click")

    const options = document.body.querySelectorAll<HTMLElement>(".ui-cascading-select__item")
    expect(options).toHaveLength(16)
    await new DOMWrapper(options[2]).trigger("click")

    expect(wrapper.emitted("update")).toEqual([[{ inputFormat: "stereo", inputChannels: [5, 6] }]])
  })
})
