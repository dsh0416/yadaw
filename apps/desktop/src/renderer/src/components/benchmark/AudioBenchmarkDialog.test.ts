import { mount } from "@vue/test-utils"
import type { AudioBenchmarkReport } from "@yadaw/contracts"
import { describe, expect, it } from "vitest"
import AudioBenchmarkDialog from "./AudioBenchmarkDialog.vue"

const report: AudioBenchmarkReport = {
  measuredAt: Date.now(),
  durationMs: 742,
  overallRealtimeFactor: 6.4,
  rating: "good",
  system: {
    cpuModel: "Reference CPU",
    logicalCores: 12,
    platform: "win32 10.0",
    architecture: "x64"
  },
  scenarios: [
    {
      id: "production-mix",
      label: "Production mix",
      description: "48 tracks with buses and sends",
      sampleRate: 48_000,
      blockSize: 128,
      tracks: 48,
      buses: 4,
      sends: 24,
      elapsedMs: 200,
      audioDurationMs: 1_280,
      averageBlockMs: 0.2,
      bufferBudgetMs: 2.667,
      realtimeFactor: 6.4
    }
  ]
}

describe("AudioBenchmarkDialog", () => {
  it("explains the test before starting it", async () => {
    const wrapper = mount(AudioBenchmarkDialog, {
      props: { status: "idle", report: null, errorMessage: "" }
    })

    expect(wrapper.text()).toContain("Measure native DSP headroom")
    await wrapper.get(".primary-button").trigger("click")
    expect(wrapper.emitted("run")).toHaveLength(1)
  })

  it("shows progress while the native test is running", () => {
    const wrapper = mount(AudioBenchmarkDialog, {
      props: { status: "running", report: null, errorMessage: "" }
    })

    expect(wrapper.text()).toContain("Rendering reference sessions")
    expect(wrapper.find(".progress-track").exists()).toBe(true)
  })

  it("renders the rating, timing lane, and machine details", () => {
    const wrapper = mount(AudioBenchmarkDialog, {
      props: { status: "complete", report, errorMessage: "" }
    })

    expect(wrapper.text()).toContain("6.4× real time")
    expect(wrapper.text()).toContain("Production mix")
    expect(wrapper.text()).toContain("Reference CPU")
    expect(wrapper.find(".timing-fill").attributes("style")).toContain("width")
  })
})
