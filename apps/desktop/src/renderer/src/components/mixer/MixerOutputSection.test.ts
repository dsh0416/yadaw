import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { UiCascadingSelect } from "@heron/ui"
import type { MixerChannelState } from "@heron/contracts"
import MixerOutputSection from "./MixerOutputSection.vue"

const channel: MixerChannelState = {
  id: "vocal",
  kind: "audio",
  systemRole: null,
  name: "Vocal",
  color: "#4F8CFF",
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

const output: MixerChannelState = {
  ...channel,
  id: "output",
  kind: "output",
  name: "Output 1–2",
  inputSource: null,
  inputFormat: null,
  outputChannelId: null,
  inputChannels: [],
  hardwareOutputChannels: [1, 2]
}

describe("MixerOutputSection", () => {
  it("routes processing channels to either a BUS or hardware Output", async () => {
    const wrapper = mount(MixerOutputSection, {
      props: {
        channel,
        buses: [{ channel: 7, name: "BUS 7" }],
        outputs: [output],
        targets: [
          { kind: "bus", bus: 7 },
          { kind: "output", channelId: "output" }
        ]
      }
    })

    const routeMenu = wrapper.getComponent(UiCascadingSelect)
    expect(routeMenu.props("appearance")).toBe("workspace")
    expect(routeMenu.props("groups")).toEqual([
      {
        label: "Buses",
        options: [{ value: "bus:7", label: "BUS 7" }]
      },
      {
        label: "Outputs",
        options: [{ value: "output:output", label: "Output 1–2" }]
      }
    ])

    routeMenu.vm.$emit("update:modelValue", "bus:7")
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted("updateChannel")).toEqual([[{ outputChannelId: null, outputBus: 7 }]])
  })

  it("uses a lightning icon and success state for the low-latency target", async () => {
    const wrapper = mount(MixerOutputSection, {
      props: {
        channel: output,
        buses: [],
        outputs: [output],
        targets: [],
        lowLatencyTarget: false,
        lowLatencyTargetDisabled: false
      }
    })

    const button = wrapper.get(
      'button[aria-label="Set Output 1–2 as the Low Latency Mode monitoring target"]'
    )
    expect(button.attributes("aria-pressed")).toBe("false")
    expect(button.find(".lucide-zap").exists()).toBe(true)
    expect(button.classes()).not.toContain("active")

    await wrapper.setProps({ lowLatencyTarget: true })
    expect(button.attributes("aria-pressed")).toBe("true")
    expect(button.classes()).toContain("active")
  })
})
