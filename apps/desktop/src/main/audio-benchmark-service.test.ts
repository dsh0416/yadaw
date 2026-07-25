import { describe, expect, it } from "vitest"
import { classifyAudioBenchmark } from "./audio-benchmark-service"

describe("classifyAudioBenchmark", () => {
  it.each([
    [1.99, "limited"],
    [2, "basic"],
    [4, "good"],
    [8, "excellent"]
  ] as const)("classifies %s× real-time headroom as %s", (factor, rating) => {
    expect(classifyAudioBenchmark(factor)).toBe(rating)
  })
})
