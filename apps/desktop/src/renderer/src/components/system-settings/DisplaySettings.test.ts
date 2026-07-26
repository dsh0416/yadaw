import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import DisplaySettings from "./DisplaySettings.vue"

describe("DisplaySettings", () => {
  beforeEach(() => {
    window.yadaw.getApplicationSettings = vi.fn().mockResolvedValue({
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      theme: "dark",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      recentProjects: []
    })
    window.yadaw.updateApplicationSettings = vi.fn().mockResolvedValue({
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      theme: "light",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      recentProjects: []
    })
  })

  it("persists a theme selected by the user", async () => {
    const wrapper = mount(DisplaySettings, {
      global: { plugins: [createPinia()] }
    })
    await flushPromises()

    const lightOption = wrapper
      .findAll('[role="radio"]')
      .find((option) => option.text().includes("Light"))
    expect(lightOption).toBeDefined()
    await lightOption!.trigger("click")
    await flushPromises()

    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledWith({ theme: "light" })
    expect(lightOption!.attributes("aria-checked")).toBe("true")
  })
})
