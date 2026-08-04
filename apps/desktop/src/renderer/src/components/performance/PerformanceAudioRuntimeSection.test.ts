import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { AudioRuntimePerformanceSnapshot } from "@heron/contracts"
import PerformanceAudioRuntimeSection from "./PerformanceAudioRuntimeSection.vue"

function audioRuntime(
  overrides: Partial<AudioRuntimePerformanceSnapshot> = {}
): AudioRuntimePerformanceSnapshot {
  return {
    sessionEpoch: "42",
    heartbeat: {
      ageMs: 12,
      controlGeneration: 1,
      tokioGeneration: 1,
      winitGeneration: 1,
      callbackGeneration: 1
    },
    requests: {
      normalPending: 0,
      capacity: 64,
      timeouts: 0
    },
    runtime: {
      requested: {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
      },
      resolved: { workerThreads: 1, maxBlockingThreads: 1 }
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

describe("PerformanceAudioRuntimeSection", () => {
  it("shows the runtime session epoch in the section heading", () => {
    const wrapper = mount(PerformanceAudioRuntimeSection, {
      props: { audioRuntime: audioRuntime({ sessionEpoch: "session-9" }) }
    })
    expect(wrapper.text()).toContain("session-9")
    expect(wrapper.find(".ipc-diagnostics-grid").exists()).toBe(true)
    wrapper.unmount()
  })

  it("falls back when diagnostics are unavailable", () => {
    const wrapper = mount(PerformanceAudioRuntimeSection, {
      props: { audioRuntime: null }
    })
    expect(wrapper.find(".monitor-placeholder").exists()).toBe(true)
    expect(wrapper.text()).not.toContain("session-9")
    wrapper.unmount()
  })
})
