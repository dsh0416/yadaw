import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MixerDisplaySettings from "./MixerDisplaySettings.vue"

const settings = {
  swapDirectory: "C:/swap",
  recordingBitDepth: "float32" as const,
  theme: "dark" as const,
  locale: "en-US" as const,
  meterPeakHold: "800ms" as const,
  meterReturnRate: "iec-type-i" as const,
  recentProjects: []
}

describe("MixerDisplaySettings", () => {
  beforeEach(() => {
    window.yadaw.getApplicationSettings = vi.fn().mockResolvedValue(settings)
    window.yadaw.updateApplicationSettings = vi
      .fn()
      .mockImplementation(async (patch) => ({ ...settings, ...patch }))
  })

  it("persists the selected peak hold time and shows the IEC return default", async () => {
    const wrapper = mount(MixerDisplaySettings, {
      global: { plugins: [createPinia()] }
    })
    await flushPromises()

    const peakHold = wrapper.get('select[aria-label="Mixer meter peak hold time"]')
    await peakHold.setValue("4s")
    await flushPromises()

    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledWith({
      meterPeakHold: "4s"
    })
    expect(wrapper.get('select[aria-label="Mixer meter return time"]').text()).toContain(
      "IEC Type I (11.8 dB/s)"
    )
  })
})
