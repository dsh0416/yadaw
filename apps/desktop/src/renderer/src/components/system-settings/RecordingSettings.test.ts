import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import RecordingSettings from "./RecordingSettings.vue"
import {
  rpcFailure,
  rpcSuccess,
  settingsSnapshot,
  testBootstrap,
  testSettings
} from "../../test/ipc"

describe("RecordingSettings", () => {
  beforeEach(() => {
    const initial = testSettings({
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      midiCenterCStandard: "roland-c4"
    })
    window.heron.bootstrap = vi
      .fn()
      .mockResolvedValue(rpcSuccess(testBootstrap({ settings: settingsSnapshot(initial) })))
    window.heron.listPendingRecordings = vi.fn().mockResolvedValue(rpcSuccess([]))
    window.heron.updateApplicationSettings = vi
      .fn()
      .mockImplementation(async (_meta, patch) =>
        rpcSuccess(settingsSnapshot(testSettings({ ...initial, ...patch }), 2))
      )
    window.heron.chooseSwapDirectory = vi
      .fn()
      .mockResolvedValue(
        rpcSuccess(
          settingsSnapshot(testSettings({ ...initial, swapDirectory: "D:/recording-swap" }), 2)
        )
      )
    window.heron.setSoftwareMonitoringEnabled = vi
      .fn()
      .mockImplementation(async (_meta, enabled) =>
        rpcSuccess(
          settingsSnapshot(testSettings({ ...initial, softwareMonitoringEnabled: enabled }), 2)
        )
      )
  })

  it("persists final bit depth and delegates swap selection", async () => {
    const wrapper = mount(RecordingSettings, { global: { plugins: [createPinia()] } })
    await vi.waitFor(() => expect(wrapper.text()).toContain("C:/swap"))

    await wrapper.get("select").setValue("pcm24")
    expect(window.heron.updateApplicationSettings).toHaveBeenCalledWith(expect.any(Object), {
      recordingBitDepth: "pcm24"
    })

    await wrapper.get('button[type="button"]').trigger("click")
    expect(window.heron.chooseSwapDirectory).toHaveBeenCalledOnce()
  })

  it("uses the dedicated software-monitoring transaction and restores the checkbox on failure", async () => {
    const wrapper = mount(RecordingSettings, { global: { plugins: [createPinia()] } })
    const checkbox = wrapper.get<HTMLInputElement>('input[type="checkbox"]')
    await vi.waitFor(() => expect(wrapper.text()).toContain("C:/swap"))
    expect(checkbox.element.disabled).toBe(false)
    expect(wrapper.text()).toContain("Off. Existing")

    await checkbox.setValue(true)
    await flushPromises()
    expect(window.heron.setSoftwareMonitoringEnabled).toHaveBeenCalledWith(expect.any(Object), true)
    expect(checkbox.element.checked).toBe(true)
    expect(wrapper.text()).toContain("Available on Audio tracks")

    window.heron.setSoftwareMonitoringEnabled = vi
      .fn()
      .mockResolvedValue(rpcFailure("errors.audioEngineUnavailable"))
    await checkbox.setValue(false)
    await flushPromises()

    expect(checkbox.element.checked).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).not.toBe("")
  })

  it("uses the design-system slider without a duplicate visible label and commits only on change", async () => {
    const wrapper = mount(RecordingSettings, { global: { plugins: [createPinia()] } })
    await vi.waitFor(() => expect(wrapper.text()).toContain("C:/swap"))

    const slider = wrapper.get<HTMLInputElement>('input[type="range"]')
    expect(wrapper.find(".latency-budget-control .ui-field__label").exists()).toBe(false)
    expect(slider.attributes("aria-label")).toBe("Low-latency plug-in budget in milliseconds")
    expect(slider.attributes("aria-valuetext")).toBe("5 ms")

    slider.element.value = "12"
    await slider.trigger("input")
    expect(window.heron.updateApplicationSettings).not.toHaveBeenCalledWith(expect.any(Object), {
      lowLatencyPluginBudgetMs: 12
    })

    await slider.trigger("change")
    await flushPromises()
    expect(window.heron.updateApplicationSettings).toHaveBeenCalledWith(expect.any(Object), {
      lowLatencyPluginBudgetMs: 12
    })
  })
})
