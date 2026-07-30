import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MidiSettings from "./MidiSettings.vue"

describe("MidiSettings", () => {
  beforeEach(() => {
    window.yadaw.getApplicationSettings = vi.fn().mockResolvedValue({
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      theme: "dark",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      recentProjects: []
    })
    window.yadaw.updateApplicationSettings = vi.fn().mockImplementation(async (patch) => ({
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      theme: "dark",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      recentProjects: [],
      ...patch
    }))
  })

  it("persists the Yamaha center C standard selected by the user", async () => {
    const wrapper = mount(MidiSettings, {
      global: { plugins: [createPinia()] }
    })
    await flushPromises()

    const yamahaOption = wrapper
      .findAll('[role="radio"]')
      .find((option) => option.text().includes("Yamaha (C3)"))
    expect(yamahaOption).toBeDefined()
    expect(
      wrapper
        .findAll('[role="radio"]')
        .find((option) => option.text().includes("Roland (C4)"))
        ?.attributes("aria-checked")
    ).toBe("true")

    await yamahaOption!.trigger("click")
    await flushPromises()

    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledWith({
      midiCenterCStandard: "yamaha-c3"
    })
    expect(yamahaOption!.attributes("aria-checked")).toBe("true")
  })
})
