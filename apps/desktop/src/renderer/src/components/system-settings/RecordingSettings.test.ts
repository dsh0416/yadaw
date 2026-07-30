import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import RecordingSettings from "./RecordingSettings.vue"

describe("RecordingSettings", () => {
  beforeEach(() => {
    window.yadaw.getApplicationSettings = vi.fn().mockResolvedValue({
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      theme: "system",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      softwareMonitoringEnabled: false,
      recentProjects: []
    })
    window.yadaw.listPendingRecordings = vi.fn().mockResolvedValue([])
    window.yadaw.updateApplicationSettings = vi.fn().mockResolvedValue({
      swapDirectory: "C:/swap",
      recordingBitDepth: "pcm24",
      theme: "system",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      softwareMonitoringEnabled: false,
      recentProjects: []
    })
    window.yadaw.chooseSwapDirectory = vi.fn().mockResolvedValue({
      swapDirectory: "D:/recording-swap",
      recordingBitDepth: "pcm24",
      theme: "system",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      softwareMonitoringEnabled: false,
      recentProjects: []
    })
    window.yadaw.setSoftwareMonitoringEnabled = vi.fn().mockResolvedValue({
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      theme: "system",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      softwareMonitoringEnabled: true,
      recentProjects: []
    })
  })

  it("persists final bit depth and delegates swap selection", async () => {
    const wrapper = mount(RecordingSettings, { global: { plugins: [createPinia()] } })
    await vi.waitFor(() => expect(wrapper.text()).toContain("C:/swap"))

    await wrapper.get("select").setValue("pcm24")
    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledWith({
      recordingBitDepth: "pcm24"
    })

    await wrapper.get('button[type="button"]').trigger("click")
    expect(window.yadaw.chooseSwapDirectory).toHaveBeenCalledOnce()
  })

  it("uses the dedicated software-monitoring transaction and restores the checkbox on failure", async () => {
    const wrapper = mount(RecordingSettings, { global: { plugins: [createPinia()] } })
    const checkbox = wrapper.get<HTMLInputElement>('input[type="checkbox"]')
    await vi.waitFor(() => expect(wrapper.text()).toContain("C:/swap"))
    expect(checkbox.element.disabled).toBe(false)
    expect(wrapper.text()).toContain("Off. Existing")

    await checkbox.setValue(true)
    await flushPromises()
    expect(window.yadaw.setSoftwareMonitoringEnabled).toHaveBeenCalledWith(true)
    expect(checkbox.element.checked).toBe(true)
    expect(wrapper.text()).toContain("Available on Audio tracks")

    window.yadaw.setSoftwareMonitoringEnabled = vi
      .fn()
      .mockRejectedValue(new Error("Recording is active"))
    await checkbox.setValue(false)
    await flushPromises()

    expect(checkbox.element.checked).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toContain("Recording is active")
  })
})
