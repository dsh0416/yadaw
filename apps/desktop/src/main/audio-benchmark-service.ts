import { arch, cpus, platform, release } from "node:os"
import type { AudioBenchmarkRating, AudioBenchmarkReport } from "@yadaw/contracts"
import { runAudioBenchmark } from "@yadaw/dsp-node"
import type { AudioHostService } from "./audio-host-service"

export function classifyAudioBenchmark(
  worstP99DeadlineUtilizationPercent: number
): AudioBenchmarkRating {
  if (worstP99DeadlineUtilizationPercent <= 20) return "excellent"
  if (worstP99DeadlineUtilizationPercent <= 40) return "good"
  if (worstP99DeadlineUtilizationPercent <= 70) return "basic"
  return "limited"
}

export async function createAudioBenchmarkReport(
  audioHost: Pick<AudioHostService, "runIpcBenchmark">
): Promise<AudioBenchmarkReport> {
  const started = performance.now()
  const result = await runAudioBenchmark()
  // Keep the CPU-bound DSP suite and IPC suite separate so neither distorts
  // the other's latency distribution.
  const ipc = await audioHost.runIpcBenchmark()
  const processors = cpus()

  return {
    measuredAt: Date.now(),
    durationMs: performance.now() - started,
    overallRealtimeFactor: result.overallRealtimeFactor,
    worstP99DeadlineUtilizationPercent: result.worstP99DeadlineUtilizationPercent,
    rating: classifyAudioBenchmark(result.worstP99DeadlineUtilizationPercent),
    system: {
      cpuModel: processors[0]?.model.trim() || "Unknown processor",
      logicalCores: processors.length,
      platform: `${platform()} ${release()}`,
      architecture: arch()
    },
    scenarios: result.scenarios,
    ipc
  }
}
