import { arch, cpus, platform, release } from "node:os"
import type {
  AudioBenchmarkRating,
  AudioBenchmarkReport,
  AudioNativeBenchmarkReport,
  PluginDescriptor
} from "@heron/contracts"
import type { AudioHostService } from "../audio-host"

export function classifyAudioBenchmark(
  worstP99DeadlineUtilizationPercent: number,
  nativeBridge?: AudioNativeBenchmarkReport
): AudioBenchmarkRating {
  const dsp =
    worstP99DeadlineUtilizationPercent <= 20
      ? "excellent"
      : worstP99DeadlineUtilizationPercent <= 40
        ? "good"
        : worstP99DeadlineUtilizationPercent <= 70
          ? "basic"
          : "limited"
  if (!nativeBridge || nativeBridge.buildProfile !== "release") return dsp
  const inlineP99 =
    nativeBridge.scenarios.find((scenario) => scenario.id === "inline-control")?.latencyP99Us ??
    Infinity
  const concurrentRate =
    nativeBridge.scenarios.find((scenario) => scenario.id === "concurrent-router")
      ?.operationsPerSecond ?? 0
  const ratio = Math.min(1_000 / inlineP99, concurrentRate / 5_000)
  const bridgeRating: AudioBenchmarkRating =
    ratio >= 1 ? "excellent" : ratio >= 0.75 ? "good" : ratio >= 0.5 ? "basic" : "limited"
  const rank: Record<AudioBenchmarkRating, number> = {
    limited: 0,
    basic: 1,
    good: 2,
    excellent: 3
  }
  return rank[bridgeRating] < rank[dsp] ? bridgeRating : dsp
}

export async function createAudioBenchmarkReport(
  audioHost: Pick<AudioHostService, "runAudioBenchmark">,
  benchmarkEffect: PluginDescriptor
): Promise<AudioBenchmarkReport> {
  const started = performance.now()
  const result = await audioHost.runAudioBenchmark(benchmarkEffect)
  const nativeBridge = result.nativeBridge
  const processors = cpus()

  return {
    measuredAt: Date.now(),
    durationMs: performance.now() - started,
    overallRealtimeFactor: result.overallRealtimeFactor,
    worstP99DeadlineUtilizationPercent: result.worstP99DeadlineUtilizationPercent,
    rating: classifyAudioBenchmark(result.worstP99DeadlineUtilizationPercent, nativeBridge),
    system: {
      cpuModel: processors[0]?.model.trim() || "Unknown processor",
      logicalCores: processors.length,
      platform: `${platform()} ${release()}`,
      architecture: arch()
    },
    scenarios: result.scenarios,
    nativeBridge
  }
}
