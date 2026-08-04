import { describe, expect, it } from "vitest"
import { classifyAudioBenchmark } from "./audio-benchmark-service"
import type { AudioNativeBenchmarkReport } from "@heron/contracts"

function nativeReport(
  buildProfile: "debug" | "release",
  concurrentRate: number,
  inlineP99Us: number
): AudioNativeBenchmarkReport {
  const scenario = (id: string, operationsPerSecond: number, latencyP99Us: number) => ({
    id,
    label: id,
    description: id,
    kind: "request-round-trip" as const,
    payloadBytes: 256,
    iterations: 1,
    concurrency: 1,
    elapsedMs: 1,
    operationsPerSecond,
    throughputMiBPerSecond: 1,
    latencyP50Us: latencyP99Us,
    latencyP95Us: latencyP99Us,
    latencyP99Us
  })
  return {
    durationMs: 1,
    buildProfile,
    runtime: { workerThreads: 2, maxBlockingThreads: 4 },
    messagePackBodyBytes: 128,
    scenarios: [
      scenario("concurrent-router", concurrentRate, 100),
      scenario("inline-control", 1, inlineP99Us)
    ]
  }
}

describe("classifyAudioBenchmark", () => {
  it.each([
    [70.01, "limited"],
    [70, "basic"],
    [40, "good"],
    [20, "excellent"]
  ] as const)("classifies %s%% p99 deadline use as %s", (utilization, rating) => {
    expect(classifyAudioBenchmark(utilization)).toBe(rating)
  })

  it("uses the worse release bridge grade but ignores debug timings", () => {
    expect(classifyAudioBenchmark(10, nativeReport("release", 1_000, 2_000))).toBe("limited")
    expect(classifyAudioBenchmark(10, nativeReport("debug", 1_000, 2_000))).toBe("excellent")
  })
})
