import { describe, expect, it } from "vitest"
import { classifyAudioBenchmark } from "./audio-benchmark-service"
import type { AudioIpcBenchmarkReport } from "@heron/contracts"

function ipcReport(
  buildProfile: "debug" | "release",
  sequential: number,
  saturated: number,
  inlineP99Us: number
): AudioIpcBenchmarkReport {
  const scenario = (id: string, throughputMiBPerSecond: number, latencyP99Us: number) => ({
    id,
    label: id,
    description: id,
    kind: "shared-saturated" as const,
    payloadBytes: 4 * 1024 * 1024,
    iterations: 1,
    concurrency: 1,
    elapsedMs: 1,
    operationsPerSecond: 1,
    throughputMiBPerSecond,
    latencyP50Us: latencyP99Us,
    latencyP95Us: latencyP99Us,
    latencyP99Us
  })
  return {
    durationMs: 1,
    buildProfile,
    runtime: { workerThreads: 2, maxBlockingThreads: 4, egressConcurrency: 2 },
    arenaOffers: 1,
    messagePackBodyBytes: 128,
    scenarios: [
      scenario("shared-warm-sequential-4m", sequential, 100),
      scenario("shared-saturated-4m-8", saturated, 100),
      scenario("inline-control", 0, inlineP99Us)
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

  it("uses the worse release IPC grade but ignores debug throughput", () => {
    expect(classifyAudioBenchmark(10, ipcReport("release", 300, 600, 2_000))).toBe("limited")
    expect(classifyAudioBenchmark(10, ipcReport("debug", 300, 600, 2_000))).toBe("excellent")
  })
})
