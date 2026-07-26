import { flushPromises, mount } from "@vue/test-utils"
import { nextTick } from "vue"
import { createPinia } from "pinia"
import { describe, expect, it, vi } from "vitest"
import AudioBenchmarkHost from "./AudioBenchmarkHost.vue"
import { useAudioBenchmarkStore } from "../../stores/audioBenchmark"

describe("AudioBenchmarkHost", () => {
  it("renders store state while the app owns the native subscription", async () => {
    let requestOpen = () => undefined
    const unsubscribe = vi.fn()
    window.yadaw.subscribeAudioBenchmarkRequests = vi.fn((listener) => {
      requestOpen = listener
      return unsubscribe
    })

    const pinia = createPinia()
    const benchmark = useAudioBenchmarkStore(pinia)
    benchmark.startSubscription()
    const wrapper = mount(AudioBenchmarkHost, { global: { plugins: [pinia] } })
    requestOpen()
    await nextTick()

    const dialog = document.body.querySelector("[role=dialog]")
    expect(dialog?.querySelectorAll(".ui-dialog__title")).toHaveLength(1)
    expect(dialog?.querySelector(".ui-dialog__title")?.textContent).toBe(
      "Audio performance benchmark"
    )
    wrapper.unmount()
    expect(unsubscribe).not.toHaveBeenCalled()
    benchmark.stopSubscription()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("runs the desktop benchmark API from the dialog action", async () => {
    window.yadaw.runAudioBenchmark = vi.fn().mockResolvedValue({
      measuredAt: 1,
      durationMs: 600,
      overallRealtimeFactor: 3,
      worstP99DeadlineUtilizationPercent: 50,
      rating: "basic",
      system: {
        cpuModel: "Host Test CPU",
        logicalCores: 4,
        platform: "test",
        architecture: "x64"
      },
      scenarios: [],
      ipc: {
        durationMs: 80,
        buildProfile: "debug",
        runtime: {
          workerThreads: 1,
          maxBlockingThreads: 2,
          egressConcurrency: 1
        },
        arenaOffers: 0,
        messagePackBodyBytes: 128,
        scenarios: []
      }
    })

    const pinia = createPinia()
    const benchmark = useAudioBenchmarkStore(pinia)
    benchmark.open()
    const wrapper = mount(AudioBenchmarkHost, { global: { plugins: [pinia] } })
    await nextTick()
    const runButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Run benchmark"
    )
    runButton?.click()
    await flushPromises()

    expect(window.yadaw.runAudioBenchmark).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain("50% headroom")
    wrapper.unmount()
  })
})
