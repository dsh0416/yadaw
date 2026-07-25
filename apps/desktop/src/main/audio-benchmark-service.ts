import { arch, cpus, platform, release } from "node:os"
import type {
  AudioBenchmarkRating,
  AudioBenchmarkReport
} from "@yadaw/contracts"
import { runAudioBenchmark } from "@yadaw/dsp-node"

export function classifyAudioBenchmark(realtimeFactor: number): AudioBenchmarkRating {
  if (realtimeFactor >= 8) return "excellent"
  if (realtimeFactor >= 4) return "good"
  if (realtimeFactor >= 2) return "basic"
  return "limited"
}

export async function createAudioBenchmarkReport(): Promise<AudioBenchmarkReport> {
  const result = await runAudioBenchmark()
  const processors = cpus()

  return {
    measuredAt: Date.now(),
    durationMs: result.durationMs,
    overallRealtimeFactor: result.overallRealtimeFactor,
    rating: classifyAudioBenchmark(result.overallRealtimeFactor),
    system: {
      cpuModel: processors[0]?.model.trim() || "Unknown processor",
      logicalCores: processors.length,
      platform: `${platform()} ${release()}`,
      architecture: arch()
    },
    scenarios: result.scenarios
  }
}
