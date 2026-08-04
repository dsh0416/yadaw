import { mount } from "@vue/test-utils"
import type { AudioBenchmarkReport } from "@heron/contracts"
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
      plugins: 32,
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
  nativeBridge: {
    durationMs: 140,
    buildProfile: "release",
    runtime: {
      workerThreads: 2,
      maxBlockingThreads: 4
    },
    messagePackBodyBytes: 128,
    scenarios: [
      {
        id: "inline-control",
        label: "Embedded control payload",
        description: "256-byte payload through the native boundary",
        kind: "request-round-trip",
        payloadBytes: 256,
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

    expect(wrapper.text()).not.toContain("Audio performance benchmark")
    expect(wrapper.text()).toContain("Runs a short local test")
    expect(wrapper.text()).toContain("bundled VST3 effects")
    expect(wrapper.text()).toContain("Pause playback and close CPU-heavy apps")
    expect(wrapper.find(".signal-map").exists()).toBe(false)
    expect(wrapper.get(".benchmark-run-button").classes()).toContain("ui-button--primary")
    await wrapper.get(".benchmark-run-button").trigger("click")
    expect(wrapper.emitted("run")).toHaveLength(1)
  })

  it("shows progress while the native test is running", () => {
    const wrapper = mount(AudioBenchmarkDialog, {
      props: { status: "running", report: null, errorMessage: "" }
    })

    expect(wrapper.text()).toContain("Measuring engine paths")
    expect(wrapper.find(".benchmark-progress").exists()).toBe(true)
    expect(wrapper.get('[role="progressbar"]').attributes("aria-label")).toContain(
      "VST3 processing"
    )
  })

  it("renders the rating, timing lane, and machine details", () => {
    const wrapper = mount(AudioBenchmarkDialog, {
      props: { status: "complete", report, errorMessage: "" }
    })

    expect(wrapper.text()).toContain("82% headroom")
    expect(wrapper.text()).toContain("Production mix")
    expect(wrapper.text()).toContain("32 VST3 effects")
    expect(wrapper.text()).toContain("Embedded control payload")
    expect(wrapper.text()).toContain("2400.0 MiB/s")
    expect(wrapper.text()).toContain("Reference CPU")
    expect(wrapper.find(".timing-fill").attributes("style")).toContain("width")
  })
})
