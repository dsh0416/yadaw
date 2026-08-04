import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"
import type { AudioRuntimePerformanceSnapshot, SystemPerformanceSnapshot } from "@heron/contracts"
import { useSystemPerformanceStore } from "./systemPerformance"

function audioRuntime(
  overrides: Partial<AudioRuntimePerformanceSnapshot> = {}
): AudioRuntimePerformanceSnapshot {
  return {
    sessionEpoch: "1",
    heartbeat: {
      ageMs: 100,
      controlGeneration: 10,
      tokioGeneration: 9,
      winitGeneration: 8,
      callbackGeneration: 7
    },
    requests: { normalPending: 0, capacity: 256, timeouts: 0 },
    runtime: {
      requested: {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
      },
      resolved: { workerThreads: 2, maxBlockingThreads: 4 }
    },
    eventQueueDepth: 0,
    telemetry: {
      epoch: "1",
      graphRevision: 3,
      callbackGeneration: 7,
      meterSlots: 8,
      capacity: 256,
      fallbackReads: 0
    },
    parameterRing: {
      used: 0,
      capacity: 256,
      softFull: 0,
      hardFull: 0,
      boundaryFallbacks: 0,
      staleEpoch: 0
    },
    ...overrides
  }
}

function snapshot(runtime: AudioRuntimePerformanceSnapshot): SystemPerformanceSnapshot {
  return {
    capturedAt: 1,
    cpu: { overallUsagePercent: 10, cores: [] },
    memory: { totalBytes: 100, usedBytes: 10, freeBytes: 90, usagePercent: 10 },
    storage: [],
    audioRuntime: runtime
  }
}

describe("system performance store embedded audio runtime health", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("reports queue, parameter, and heartbeat pressure", () => {
    const store = useSystemPerformanceStore()
    store.snapshot = snapshot(
      audioRuntime({
        heartbeat: {
          ageMs: 1_600,
          controlGeneration: 10,
          tokioGeneration: 9,
          winitGeneration: 8,
          callbackGeneration: 7
        },
        requests: { normalPending: 240, capacity: 256, timeouts: 3 },
        parameterRing: {
          used: 240,
          capacity: 256,
          softFull: 0,
          hardFull: 1,
          boundaryFallbacks: 0,
          staleEpoch: 0
        }
      })
    )

    expect(store.warnings.map((warning) => warning.id)).toEqual([
      "audio-runtime-heartbeat",
      "audio-runtime-queue-pressure",
      "audio-runtime-parameter-pressure"
    ])
    expect(store.severity).toBe("critical")
  })

  it("does not warn only because cumulative counters are non-zero", () => {
    const store = useSystemPerformanceStore()
    store.snapshot = snapshot(
      audioRuntime({
        requests: { normalPending: 0, capacity: 256, timeouts: 12 },
        parameterRing: {
          used: 0,
          capacity: 256,
          softFull: 0,
          hardFull: 4,
          boundaryFallbacks: 0,
          staleEpoch: 1
        }
      })
    )

    expect(store.warnings).toEqual([])
    expect(store.severity).toBe("normal")
  })
})
