import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import RecordingPreferences from "./RecordingPreferences.vue"

describe("RecordingPreferences", () => {
  beforeEach(() => {
    window.yadaw.getApplicationSettings = vi.fn().mockResolvedValue({
      swapDirectory: "C:/swap", recordingBitDepth: "float32", theme: "system", recentProjects: []
    })
    window.yadaw.listPendingRecordings = vi.fn().mockResolvedValue([])
    window.yadaw.updateApplicationSettings = vi.fn().mockResolvedValue({
      swapDirectory: "C:/swap", recordingBitDepth: "pcm24", theme: "system", recentProjects: []
    })
    window.yadaw.chooseSwapDirectory = vi.fn().mockResolvedValue({
      swapDirectory: "D:/recording-swap", recordingBitDepth: "pcm24", theme: "system", recentProjects: []
    })
  })

  it("persists final bit depth and delegates swap selection", async () => {
    const wrapper = mount(RecordingPreferences, { global: { plugins: [createPinia()] } })
    await vi.waitFor(() => expect(wrapper.text()).toContain("C:/swap"))
    await wrapper.get("select").setValue("pcm24")
    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledWith({ recordingBitDepth: "pcm24" })
    await wrapper.get("button").trigger("click")
    expect(window.yadaw.chooseSwapDirectory).toHaveBeenCalledOnce()
  })
})
