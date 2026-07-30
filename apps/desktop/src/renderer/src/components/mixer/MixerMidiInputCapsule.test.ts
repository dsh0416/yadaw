import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import MixerMidiInputCapsule from "./MixerMidiInputCapsule.vue"

vi.mock("@yadaw/ui", () => ({
  UiSelect: {
    props: ["modelValue"],
    emits: ["update:modelValue"],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>'
  }
}))

const UiSelect = {
  props: ["modelValue"],
  emits: ["update:modelValue"],
  template:
    '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>'
}

describe("MixerMidiInputCapsule", () => {
  it("emits stable port identity and zero-based channel values", async () => {
    const wrapper = mount(MixerMidiInputCapsule, {
      props: {
        route: { portId: null, portName: null, channel: null },
        ports: [{ id: "port-a", name: "Keyboard", connected: true }]
      },
      global: { stubs: { UiSelect } }
    })

    const selects = wrapper.findAll("select")
    await selects[0]!.setValue("port-a")
    await selects[1]!.setValue("15")

    expect(wrapper.emitted("update")).toEqual([
      [{ portId: "port-a", portName: "Keyboard", channel: null }],
      [{ portId: null, portName: null, channel: 15 }]
    ])
  })

  it("keeps a disconnected explicit route visible as Missing", () => {
    const wrapper = mount(MixerMidiInputCapsule, {
      props: {
        route: { portId: "gone", portName: "Stage Piano", channel: 0 },
        ports: []
      },
      global: { stubs: { UiSelect } }
    })

    expect(wrapper.classes()).toContain("missing")
    expect(wrapper.text()).toContain("Stage Piano — Missing")
  })
})
