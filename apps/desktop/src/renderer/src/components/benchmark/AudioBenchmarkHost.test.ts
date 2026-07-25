import { flushPromises, mount } from "@vue/test-utils"
import { nextTick } from "vue"
import { describe, expect, it, vi } from "vitest"
import AudioBenchmarkHost from "./AudioBenchmarkHost.vue"

describe("AudioBenchmarkHost", () => {
  it("opens from the native Help menu request and unsubscribes on teardown", async () => {
    let requestOpen = () => undefined
    const unsubscribe = vi.fn()
    window.yadaw.subscribeAudioBenchmarkRequests = vi.fn((listener) => {
      requestOpen = listener
      return unsubscribe
    })

    const wrapper = mount(AudioBenchmarkHost)
    requestOpen()
    await nextTick()

    expect(document.body.textContent).toContain("Audio performance benchmark")
    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("runs the desktop benchmark API from the dialog action", async () => {
    window.yadaw.subscribeAudioBenchmarkRequests = vi.fn((listener) => {
      listener()
      return () => undefined
    })
    window.yadaw.runAudioBenchmark = vi.fn().mockResolvedValue({
      measuredAt: 1,
      durationMs: 600,
      overallRealtimeFactor: 3,
      rating: "basic",
      system: {
        cpuModel: "Host Test CPU",
        logicalCores: 4,
        platform: "test",
        architecture: "x64"
      },
      scenarios: []
    })

    const wrapper = mount(AudioBenchmarkHost)
    await nextTick()
    const runButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Run benchmark")
    runButton?.click()
    await flushPromises()

    expect(window.yadaw.runAudioBenchmark).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain("3.0× real time")
    wrapper.unmount()
  })
})
