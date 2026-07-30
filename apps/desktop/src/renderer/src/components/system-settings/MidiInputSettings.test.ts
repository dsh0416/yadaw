import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import MidiInputSettings from "./MidiInputSettings.vue"

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

const SettingsPage = { template: "<main><slot /></main>" }
const SettingsSection = { template: "<section><slot /></section>" }

describe("MidiInputSettings", () => {
  it("applies one clock source and clamps per-port timing correction", async () => {
    const wrapper = mount(MidiInputSettings, {
      props: {
        preferences: {
          enabled: false,
          sourcePortId: null,
          sourcePortName: null,
          inputOffsetsMs: {}
        },
        snapshot: {
          ports: [{ id: "port-a", name: "Keyboard", connected: true }],
          sync: {
            state: "internal",
            sourcePortId: null,
            sourcePortName: null,
            effectiveBpm: null,
            jitterMicroseconds: 0,
            lastClockAgeMs: null,
            droppedEvents: 0,
            ignoredSystemMessages: 0,
            error: null
          },
          controlEvents: [],
          capturedAt: 1
        },
        applying: false,
        error: ""
      },
      global: { stubs: { UiSelect, SettingsPage, SettingsSection } }
    })

    await wrapper.get('input[type="checkbox"]').setValue(true)
    await wrapper.get("select").setValue("port-a")
    await wrapper.get('input[type="number"]').setValue("900")
    await wrapper.get("button").trigger("click")

    expect(wrapper.emitted("apply")?.[0]).toEqual([
      {
        enabled: true,
        sourcePortId: "port-a",
        sourcePortName: "Keyboard",
        inputOffsetsMs: { "port-a": 500 }
      }
    ])
  })

  it("shows external lock diagnostics and missing ports", () => {
    const wrapper = mount(MidiInputSettings, {
      props: {
        preferences: {
          enabled: true,
          sourcePortId: "gone",
          sourcePortName: "Clock Box",
          inputOffsetsMs: {}
        },
        snapshot: {
          ports: [{ id: "gone", name: "Clock Box", connected: false }],
          sync: {
            state: "freewheel",
            sourcePortId: "gone",
            sourcePortName: "Clock Box",
            effectiveBpm: 123.456,
            jitterMicroseconds: 81,
            lastClockAgeMs: 90,
            droppedEvents: 2,
            ignoredSystemMessages: 1,
            error: null
          },
          controlEvents: [],
          capturedAt: 1
        },
        applying: false,
        error: ""
      },
      global: { stubs: { UiSelect, SettingsPage, SettingsSection } }
    })

    expect(wrapper.text()).toContain("Freewheel")
    expect(wrapper.text()).toContain("123.46 BPM")
    expect(wrapper.text()).toContain("Missing")
  })
})
