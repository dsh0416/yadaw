import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MixerDisplaySettings from "./MixerDisplaySettings.vue"
import { rpcSuccess, settingsSnapshot, testBootstrap, testSettings } from "../../test/ipc"

const settings = {
  swapDirectory: "C:/swap",
  recordingBitDepth: "float32" as const,
  theme: "dark" as const,
  locale: "en-US" as const,
  meterPeakHold: "800ms" as const,
  meterReturnRate: "iec-type-i" as const,
  midiCenterCStandard: "roland-c4" as const,
  recentProjects: []
}

describe("MixerDisplaySettings", () => {
  beforeEach(() => {
    window.heron.bootstrap = vi
      .fn()
      .mockResolvedValue(
        rpcSuccess(testBootstrap({ settings: settingsSnapshot(testSettings(settings)) }))
      )
    window.heron.updateApplicationSettings = vi
      .fn()
      .mockImplementation(async (_meta, patch) =>
        rpcSuccess(settingsSnapshot(testSettings({ ...settings, ...patch }), 2))
      )
  })

  it("persists the selected peak hold time and shows the IEC return default", async () => {
    const wrapper = mount(MixerDisplaySettings, {
      global: { plugins: [createPinia()] }
    })
    await flushPromises()

    const peakHold = wrapper.get('select[aria-label="Mixer meter peak hold time"]')
    await peakHold.setValue("4s")
    await flushPromises()

    expect(window.heron.updateApplicationSettings).toHaveBeenCalledWith(expect.any(Object), {
      meterPeakHold: "4s"
    })
    expect(wrapper.get('select[aria-label="Mixer meter return time"]').text()).toContain(
      "IEC Type I (11.8 dB/s)"
    )
  })
})
