import { flushPromises, mount } from "@vue/test-utils"
import { nextTick } from "vue"
import { createPinia } from "pinia"
import { describe, expect, it, vi } from "vitest"
import AudioBenchmarkHost from "./AudioBenchmarkHost.vue"
import { useAudioBenchmarkStore } from "../../stores/audioBenchmark"

import { rpcSuccess, testBootstrap } from "../../test/ipc"
import { useAudioRuntimeStore } from "../../stores/audioRuntime"
describe("AudioBenchmarkHost", () => {
  it("renders the benchmark dialog when application commands open the store", async () => {
    const pinia = createPinia()
    const benchmark = useAudioBenchmarkStore(pinia)
    benchmark.open()
    const wrapper = mount(AudioBenchmarkHost, { global: { plugins: [pinia] } })
    await nextTick()

    const dialog = document.body.querySelector("[role=dialog]")
    expect(dialog?.querySelectorAll(".ui-dialog__title")).toHaveLength(1)
    expect(dialog?.querySelector(".ui-dialog__title")?.textContent).toBe(
      "Audio performance benchmark"
    )
    wrapper.unmount()
  })

  it("runs the desktop benchmark API from the dialog action", async () => {
    const pinia = createPinia()
    useAudioRuntimeStore(pinia).applyResources(testBootstrap().audioResources)
    window.heron.runAudioBenchmark = vi.fn().mockResolvedValue(
      rpcSuccess({
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
        nativeBridge: {
          durationMs: 80,
          buildProfile: "debug",
          runtime: {
            workerThreads: 1,
            maxBlockingThreads: 2
          },
          messagePackBodyBytes: 128,
          scenarios: []
        }
      })
    )

    const benchmark = useAudioBenchmarkStore(pinia)
    benchmark.open()
    const wrapper = mount(AudioBenchmarkHost, { global: { plugins: [pinia] } })
    await nextTick()
    const runButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Run benchmark"
    )
    runButton?.click()
    await flushPromises()

    expect(window.heron.runAudioBenchmark).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain("50% headroom")
    wrapper.unmount()
  })
})
