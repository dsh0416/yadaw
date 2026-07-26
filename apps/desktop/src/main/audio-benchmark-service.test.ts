import { describe, expect, it } from "vitest"
import { classifyAudioBenchmark } from "./audio-benchmark-service"

describe("classifyAudioBenchmark", () => {
  it.each([
    [70.01, "limited"],
    [70, "basic"],
    [40, "good"],
    [20, "excellent"]
  ] as const)("classifies %s%% p99 deadline use as %s", (utilization, rating) => {
    expect(classifyAudioBenchmark(utilization)).toBe(rating)
  })
})
