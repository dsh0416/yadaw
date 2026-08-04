import { arch, cpus, platform, release } from "node:os"
import type {
  AudioBenchmarkRating,
  AudioBenchmarkReport,
  AudioIpcBenchmarkReport,
  PluginDescriptor
} from "@heron/contracts"
import type { AudioHostService } from "../audio-host"

export function classifyAudioBenchmark(
  worstP99DeadlineUtilizationPercent: number,
  ipc?: AudioIpcBenchmarkReport
): AudioBenchmarkRating {
  const dsp =
    worstP99DeadlineUtilizationPercent <= 20
      ? "excellent"
      : worstP99DeadlineUtilizationPercent <= 40
        ? "good"
        : worstP99DeadlineUtilizationPercent <= 70
          ? "basic"
          : "limited"
  if (!ipc || ipc.buildProfile !== "release") return dsp
  const sequential =
    ipc.scenarios.find((scenario) => scenario.id === "shared-warm-sequential-4m")
      ?.throughputMiBPerSecond ?? 0
  const saturated =
    ipc.scenarios.find((scenario) => scenario.id === "shared-saturated-4m-8")
      ?.throughputMiBPerSecond ?? 0
  const inlineP99 =
    ipc.scenarios.find((scenario) => scenario.id === "inline-control")?.latencyP99Us ?? Infinity
  const ratio = Math.min(sequential / 750, saturated / 1_500, 1_000 / inlineP99)
  const ipcRating: AudioBenchmarkRating =
    ratio >= 1 ? "excellent" : ratio >= 0.75 ? "good" : ratio >= 0.5 ? "basic" : "limited"
  const rank: Record<AudioBenchmarkRating, number> = {
    limited: 0,
    basic: 1,
    good: 2,
    excellent: 3
  }
  return rank[ipcRating] < rank[dsp] ? ipcRating : dsp
}

export async function createAudioBenchmarkReport(
  audioHost: Pick<AudioHostService, "runAudioBenchmark">,
  benchmarkEffect: PluginDescriptor
): Promise<AudioBenchmarkReport> {
  const started = performance.now()
  const result = await audioHost.runAudioBenchmark(benchmarkEffect)
  const ipc = result.ipc
  const processors = cpus()

  return {
    measuredAt: Date.now(),
    durationMs: performance.now() - started,
    overallRealtimeFactor: result.overallRealtimeFactor,
    worstP99DeadlineUtilizationPercent: result.worstP99DeadlineUtilizationPercent,
    rating: classifyAudioBenchmark(result.worstP99DeadlineUtilizationPercent, ipc),
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
