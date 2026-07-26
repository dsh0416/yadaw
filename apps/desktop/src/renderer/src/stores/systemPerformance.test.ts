import { beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { AudioIpcPerformanceSnapshot, SystemPerformanceSnapshot } from "@yadaw/contracts"
import { useSystemPerformanceStore } from "./systemPerformance"

function audioIpc(
  overrides: Partial<AudioIpcPerformanceSnapshot> = {}
): AudioIpcPerformanceSnapshot {
  return {
    protocolVersion: 3,
    sessionEpoch: "1",
    heartbeat: {
      ageMs: 100,
      ipcGeneration: 10,
      tokioGeneration: 9,
      winitGeneration: 8,
      callbackGeneration: 7
    },
    requests: {
      normalPending: 0,
      priorityPending: 0,
      capacity: 256,
      timeouts: 0
    },
    sharedMemory: {
      outstandingLeases: 0,
      outstandingBytes: 0,
      maxLeases: 256,
      maxBytes: 512 * 1024 * 1024,
      inlinePackets: 20,
      inlineBytes: 2_048,
      sharedPackets: 1,
      sharedRegions: 1,
      sharedBytes: 128 * 1024,
      arenaRegions: 1,
      arenaCapacityBytes: 1024 * 1024,
      arenaUsedBytes: 0,
      arenaHighWaterBytes: 128 * 1024,
      arenaOffers: 1,
      arenaBusy: 0,
      arenaQuarantinedRegions: 0,
      copiedBytes: 128 * 1024
    },
    runtime: {
      requested: {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      resolved: { workerThreads: 2, maxBlockingThreads: 4, egressConcurrency: 2 },
      egressActive: 0,
      egressQueueDepth: 0,
      egressQueueHighWater: 0,
      egressBatches: 0,
      blockingJobs: 0
    },
    eventQueueDepth: 0,
    telemetry: {
      epoch: "1",
      graphRevision: 3,
      callbackGeneration: 7,
      meterSlots: 8,
      capacity: 64,
      fallbackReads: 0
    },
    parameterRing: {
      used: 0,
      capacity: 4_096,
      softFull: 0,
      hardFull: 0,
      boundaryFallbacks: 0,
      staleEpoch: 0
    },
    ...overrides
  }
}

function snapshot(ipc: AudioIpcPerformanceSnapshot): SystemPerformanceSnapshot {
  return {
    capturedAt: 1,
    cpu: { overallUsagePercent: 10, cores: [] },
    memory: {
      totalBytes: 100,
      usedBytes: 10,
      freeBytes: 90,
      usagePercent: 10
    },
    storage: [],
    audioIpc: ipc
  }
}

describe("system performance store audio IPC health", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("reports current router, lease, parameter ring, and heartbeat pressure", () => {
    const store = useSystemPerformanceStore()
    store.snapshot = snapshot(
      audioIpc({
        heartbeat: {
          ageMs: 1_600,
          ipcGeneration: 10,
          tokioGeneration: 9,
          winitGeneration: 8,
          callbackGeneration: 7
        },
        requests: {
          normalPending: 240,
          priorityPending: 0,
          capacity: 256,
          timeouts: 3
        },
        sharedMemory: {
          outstandingLeases: 230,
          outstandingBytes: 0,
          maxLeases: 256,
          maxBytes: 512 * 1024 * 1024,
          inlinePackets: 20,
          inlineBytes: 2_048,
          sharedPackets: 1,
          sharedRegions: 1,
          sharedBytes: 128 * 1024,
          arenaRegions: 32,
          arenaCapacityBytes: 256 * 1024 * 1024,
          arenaUsedBytes: 0,
          arenaHighWaterBytes: 128 * 1024,
          arenaOffers: 32,
          arenaBusy: 1,
          arenaQuarantinedRegions: 0,
          copiedBytes: 128 * 1024
        },
        parameterRing: {
          used: 3_800,
          capacity: 4_096,
          softFull: 2,
          hardFull: 1,
          boundaryFallbacks: 1,
          staleEpoch: 0
        }
      })
    )

    expect(store.warnings.map((warning) => warning.id)).toEqual([
      "audio-ipc-heartbeat",
      "audio-ipc-router-pressure",
      "audio-ipc-shared-memory-pressure",
      "audio-ipc-parameter-ring-pressure"
    ])
    expect(store.severity).toBe("critical")
  })

  it("does not warn only because cumulative fallback counters are non-zero", () => {
    const store = useSystemPerformanceStore()
    store.snapshot = snapshot(
      audioIpc({
        requests: {
          normalPending: 0,
          priorityPending: 0,
          capacity: 256,
          timeouts: 12
        },
        telemetry: {
          epoch: "1",
          graphRevision: 3,
          callbackGeneration: 7,
          meterSlots: 8,
          capacity: 64,
          fallbackReads: 20
        },
        parameterRing: {
          used: 0,
          capacity: 4_096,
          softFull: 30,
          hardFull: 4,
          boundaryFallbacks: 2,
          staleEpoch: 1
        }
      })
    )

    expect(store.warnings).toEqual([])
    expect(store.severity).toBe("normal")
  })
})
