import { describe, expect, it, vi } from "vitest"
import type { AudioBenchmarkReport } from "@yadaw/contracts"
import { useAudioBenchmark } from "./useAudioBenchmark"

const report: AudioBenchmarkReport = {
  measuredAt: 1,
  durationMs: 600,
  overallRealtimeFactor: 10,
  rating: "excellent",
  system: {
    cpuModel: "Test CPU",
    logicalCores: 8,
    platform: "test",
    architecture: "x64"
  },
  scenarios: []
}

describe("useAudioBenchmark", () => {
  it("runs the exposed desktop API and stores its report", async () => {
    window.yadaw.runAudioBenchmark = vi.fn().mockResolvedValue(report)
    const benchmark = useAudioBenchmark()

    await benchmark.run()

    expect(window.yadaw.runAudioBenchmark).toHaveBeenCalledOnce()
    expect(benchmark.status.value).toBe("complete")
    expect(benchmark.report.value).toEqual(report)
  })

  it("keeps a useful error when the native benchmark fails", async () => {
    window.yadaw.runAudioBenchmark = vi.fn().mockRejectedValue(new Error("Native worker stopped"))
    const benchmark = useAudioBenchmark()

    await benchmark.run()

    expect(benchmark.status.value).toBe("error")
    expect(benchmark.errorMessage.value).toBe("Native worker stopped")
  })
})
