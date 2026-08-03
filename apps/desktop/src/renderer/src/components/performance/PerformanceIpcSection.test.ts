import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { AudioIpcPerformanceSnapshot } from "@heron/contracts"
import PerformanceIpcSection from "./PerformanceIpcSection.vue"

function audioIpc(
  overrides: Partial<AudioIpcPerformanceSnapshot> = {}
): AudioIpcPerformanceSnapshot {
  return {
    sessionEpoch: "42",
    heartbeat: {
      ageMs: 12,
      ipcGeneration: 1,
      tokioGeneration: 1,
      winitGeneration: 1,
      callbackGeneration: 1
    },
    requests: {
      normalPending: 0,
      priorityPending: 0,
      capacity: 64,
      timeouts: 0
    },
    sharedMemory: {
      persistentPagesActive: true,
      activationFailures: 0,
      outstandingLeases: 0,
      outstandingBytes: 0,
      maxLeases: 64,
      maxBytes: 1024,
      inlinePackets: 0,
      inlineBytes: 0,
      sharedPackets: 0,
      sharedRegions: 0,
      sharedBytes: 0,
      arenaRegions: 0,
      arenaCapacityBytes: 0,
      arenaUsedBytes: 0,
      arenaHighWaterBytes: 0,
      arenaOffers: 0,
      arenaBusy: 0,
      arenaQuarantinedRegions: 0,
      copiedBytes: 0
    },
    runtime: {
      requested: {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      resolved: { workerThreads: 1, maxBlockingThreads: 1, egressConcurrency: 1 },
      egressActive: 0,
      egressQueueDepth: 0,
      egressQueueHighWater: 0,
      egressBatches: 0,
      blockingJobs: 0
    },
    eventQueueDepth: 0,
    telemetry: {
      epoch: "1",
      graphRevision: 0,
      callbackGeneration: 0,
      meterSlots: 0,
      capacity: 1,
      fallbackReads: 0
    },
    parameterRing: {
      used: 0,
      capacity: 1,
      softFull: 0,
      hardFull: 0,
      boundaryFallbacks: 0,
      staleEpoch: 0
    },
    ...overrides
  }
}

describe("PerformanceIpcSection", () => {
  it("shows the helper session epoch in the section heading", () => {
    const wrapper = mount(PerformanceIpcSection, {
      props: { audioIpc: audioIpc({ sessionEpoch: "session-9" }) }
    })
    expect(wrapper.text()).toContain("session-9")
    expect(wrapper.find(".ipc-diagnostics-grid").exists()).toBe(true)
    wrapper.unmount()
  })

  it("falls back when diagnostics are unavailable", () => {
    const wrapper = mount(PerformanceIpcSection, {
      props: { audioIpc: null }
    })
    expect(wrapper.find(".monitor-placeholder").exists()).toBe(true)
    expect(wrapper.text()).not.toContain("session-9")
    wrapper.unmount()
  })
})
