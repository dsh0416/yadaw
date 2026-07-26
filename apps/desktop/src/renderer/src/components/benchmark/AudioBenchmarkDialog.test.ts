import { mount } from "@vue/test-utils"
import type { AudioBenchmarkReport } from "@yadaw/contracts"
import { describe, expect, it } from "vitest"
import AudioBenchmarkDialog from "./AudioBenchmarkDialog.vue"

const report: AudioBenchmarkReport = {
  measuredAt: Date.now(),
  durationMs: 742,
  overallRealtimeFactor: 6.4,
  worstP99DeadlineUtilizationPercent: 18,
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
      p95BlockMs: 0.28,
      p99BlockMs: 0.48,
      maxBlockMs: 0.62,
      bufferBudgetMs: 2.667,
      p99DeadlineUtilizationPercent: 18,
      deadlineMisses: 0,
      measuredBlocks: 480,
      realtimeFactor: 6.4
    }
  ],
  ipc: {
    durationMs: 140,
    scenarios: [
      {
        id: "shared-plugin-state",
        label: "Large shared state",
        description: "4 MiB payload representative of a large plug-in state",
        kind: "shared-round-trip",
        payloadBytes: 4 * 1024 * 1024,
        iterations: 12,
        concurrency: 1,
        elapsedMs: 40,
        operationsPerSecond: 300,
        throughputMiBPerSecond: 2400,
        latencyP50Us: 220,
        latencyP95Us: 310,
        latencyP99Us: 340
      }
    ]
  }
}

describe("AudioBenchmarkDialog", () => {
  it("explains the test before starting it", async () => {
    const wrapper = mount(AudioBenchmarkDialog, {
      props: { status: "idle", report: null, errorMessage: "" }
    })

    expect(wrapper.text()).toContain("Measure DSP deadlines and IPC")
    await wrapper.get(".primary-button").trigger("click")
    expect(wrapper.emitted("run")).toHaveLength(1)
  })

  it("shows progress while the native test is running", () => {
    const wrapper = mount(AudioBenchmarkDialog, {
      props: { status: "running", report: null, errorMessage: "" }
    })

    expect(wrapper.text()).toContain("Measuring engine paths")
    expect(wrapper.find(".progress-track").exists()).toBe(true)
  })

  it("renders the rating, timing lane, and machine details", () => {
    const wrapper = mount(AudioBenchmarkDialog, {
      props: { status: "complete", report, errorMessage: "" }
    })

    expect(wrapper.text()).toContain("82% headroom")
    expect(wrapper.text()).toContain("Production mix")
    expect(wrapper.text()).toContain("Large shared state")
    expect(wrapper.text()).toContain("2400.0 MiB/s")
    expect(wrapper.text()).toContain("Reference CPU")
    expect(wrapper.find(".timing-fill").attributes("style")).toContain("width")
  })
})
