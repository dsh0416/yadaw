import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { UiCascadingSelect } from "@yadaw/ui"
import type { MixerChannelState } from "@yadaw/contracts"
import MixerOutputSection from "./MixerOutputSection.vue"

const channel: MixerChannelState = {
  id: "vocal",
  kind: "audio",
  systemRole: null,
  name: "Vocal",
  color: "#4F8CFF",
  sortOrder: 0,
  inputFormat: "mono",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

const output: MixerChannelState = {
  ...channel,
  id: "output",
  kind: "output",
  name: "Output 1–2",
  inputFormat: null,
  outputChannelId: null,
  inputChannels: [],
  hardwareOutputChannels: [1, 2]
}

const bus: MixerChannelState = {
  ...channel,
  id: "reverb",
  kind: "bus",
  name: "Reverb",
  inputFormat: null,
  outputChannelId: "output",
  inputChannels: []
}

describe("MixerOutputSection", () => {
  it("groups route candidates into output and bus submenus", async () => {
    const wrapper = mount(MixerOutputSection, {
      props: {
        channel,
        outputs: [output, bus]
      }
    })

    const routeMenu = wrapper.getComponent(UiCascadingSelect)
    expect(routeMenu.props("groups")).toEqual([
      {
        label: "Outputs",
        options: [{ value: "output", label: "Output 1–2" }]
      },
      {
        label: "Buses",
        options: [{ value: "reverb", label: "Reverb" }]
      }
    ])

    routeMenu.vm.$emit("update:modelValue", "reverb")
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted("updateChannel")).toEqual([[{ outputChannelId: "reverb" }]])
  })
})
