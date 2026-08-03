import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AudioBenchmarkReport } from "@yadaw/contracts"
import { useAudioBenchmarkStore } from "./audioBenchmark"
import { useAudioRuntimeStore } from "./audioRuntime"
import { rpcFailure, rpcSuccess, testBootstrap, TEST_AUDIO_HOST_REF } from "../test/ipc"
import { useProjectStore } from "./project"

const report: AudioBenchmarkReport = {
  measuredAt: Date.now(),
  durationMs: 742,
  overallRealtimeFactor: 6.4,
  worstP99DeadlineUtilizationPercent: 18,
  rating: "good",
  system: {
    cpuModel: "Reference CPU",
    logicalCores: 12,
    platform: "linux",
    architecture: "x64"
  },
  scenarios: [],
  ipc: {
    durationMs: 140,
    buildProfile: "release",
    runtime: {
      workerThreads: 2,
      maxBlockingThreads: 4,
      egressConcurrency: 2
    },
    arenaOffers: 1,
    messagePackBodyBytes: 128,
    scenarios: []
  }
}

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

beforeEach(() => {
  setActivePinia(createPinia())
  useProjectStore().applyBootstrap(testBootstrap())
  useAudioRuntimeStore().applyResources(testBootstrap().audioResources)
})

describe("useAudioBenchmarkStore", () => {
  it("opens and closes the benchmark panel", () => {
    const store = useAudioBenchmarkStore()

    store.open()
    expect(store.isOpen).toBe(true)

    store.close()
    expect(store.isOpen).toBe(false)
  })

  it("runs the benchmark against the audio host resource", async () => {
    const runAudioBenchmark = vi.fn(async () => rpcSuccess(report))
    stubApi({ runAudioBenchmark })
    const store = useAudioBenchmarkStore()

    await store.run()

    expect(runAudioBenchmark).toHaveBeenCalledTimes(1)
    expect(store.status).toBe("complete")
    expect(store.report).toEqual(report)
    expect(store.errorMessage).toBe("")
  })

  it("records typed RPC failures", async () => {
    stubApi({
      runAudioBenchmark: vi.fn(async () => rpcFailure("errors.audioEngineUnavailable"))
    })
    const store = useAudioBenchmarkStore()

    await store.run()

    expect(store.status).toBe("error")
    expect(store.report).toBeNull()
    expect(store.errorMessage).not.toBe("")
  })

  it("refuses to start a second run while one is in flight", async () => {
    let resolveBenchmark: ((value: ReturnType<typeof rpcSuccess<AudioBenchmarkReport>>) => void) | null =
      null
    const runAudioBenchmark = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveBenchmark = resolve
        })
    )
    stubApi({ runAudioBenchmark })
    const store = useAudioBenchmarkStore()

    const first = store.run()
    const second = store.run()

    expect(runAudioBenchmark).toHaveBeenCalledTimes(1)
    resolveBenchmark?.(rpcSuccess(report))
    await first
    await second
    expect(store.status).toBe("complete")
  })

  it("reports when the audio host resource is unavailable", async () => {
    useAudioRuntimeStore().audioHostRef = null
    const store = useAudioBenchmarkStore()

    await store.run()

    expect(store.status).toBe("error")
    expect(store.errorMessage).toContain("unavailable")
    expect(store.report).toBeNull()
  })

  it("uses the audio host ref from the runtime store", async () => {
    const runAudioBenchmark = vi.fn(async () => rpcSuccess(report))
    stubApi({ runAudioBenchmark })
    const store = useAudioBenchmarkStore()

    await store.run()

    expect(runAudioBenchmark.mock.calls[0]?.[0]).toMatchObject({
      target: TEST_AUDIO_HOST_REF
    })
  })
})
