import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@heron/contracts"
import type { AudioRuntimeSnapshot, SystemPerformanceSnapshot } from "@heron/contracts"
import type { AudioTelemetryStatistics } from "../../stores/audioRuntime"
import { useSystemPerformanceStore } from "../../stores/systemPerformance"
import PerformanceMonitorPopover from "./PerformanceMonitorPopover.vue"

const statistics: AudioTelemetryStatistics = {
  sampleCount: 2,
  averageRoundTripLatencyMs: 18,
  maximumRoundTripLatencyMs: 24,
  maximumOutputLatencyMs: 8,
  minimumRingBufferFillFrames: 64,
  maximumRingBufferFillFrames: 128,
  sessionXruns: 0
}

function runtime(overrides: Partial<AudioRuntimeSnapshot> = {}): AudioRuntimeSnapshot {
  return { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT, ...overrides }
}

function snapshot(): SystemPerformanceSnapshot {
  return {
    capturedAt: 1,
    cpu: { overallUsagePercent: 96, cores: [] },
    memory: { totalBytes: 100, usedBytes: 82, freeBytes: 18, usagePercent: 82 },
    storage: [],
    audioRuntime: null
  }
}

function mountPopover(
  audioRuntime: AudioRuntimeSnapshot,
  audioWarnings = [] as Array<{
    id: string
    severity: "warning" | "critical"
    title: string
    message: string
  }>
) {
  return mount(PerformanceMonitorPopover, {
    props: { runtime: audioRuntime, statistics, audioWarnings },
    global: {
      stubs: {
        UiPopover: { template: '<div><slot name="trigger"/><slot/></div>' },
        PerformanceResourceSections: { template: '<div class="resources" />' },
        PerformanceAudioSection: { template: '<div class="audio" />' },
        PerformanceAudioRuntimeSection: { template: '<div class="runtime" />' }
      }
    }
  })
}

describe("PerformanceMonitorPopover", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("shows unavailable readings without raising latency warnings while stopped", () => {
    const wrapper = mountPopover(runtime())
    const trigger = wrapper.find(".performance-trigger")

    expect(trigger.classes()).toContain("normal")
    expect(trigger.text()).toContain("CPU —")
    expect(trigger.text()).toContain("MEM —")
    expect(wrapper.find(".performance-alerts").exists()).toBe(false)
  })

  it("combines system, audio, and measured latency health", () => {
    const store = useSystemPerformanceStore()
    store.snapshot = snapshot()
    const wrapper = mountPopover(runtime({ state: "running", estimatedRoundTripLatencyMs: 42 }), [
      {
        id: "xrun",
        severity: "warning",
        title: "Audio interruption",
        message: "One callback missed its deadline"
      }
    ])

    expect(wrapper.find(".performance-trigger").classes()).toContain("critical")
    expect(wrapper.find(".performance-trigger").text()).toContain("CPU 96%")
    expect(wrapper.find(".performance-trigger").text()).toContain("MEM 82%")
    const alerts = wrapper.findAll(".performance-alert")
    expect(alerts.length).toBeGreaterThanOrEqual(3)
    expect(wrapper.text()).toContain("Audio interruption")
    expect(wrapper.text()).toContain("42.0 ms")
  })

  it("delegates a manual refresh and disables the action while refreshing", async () => {
    const store = useSystemPerformanceStore()
    const refresh = vi.spyOn(store, "refresh").mockResolvedValue()
    const wrapper = mountPopover(runtime())

    await wrapper.find(".refresh-performance").trigger("click")
    expect(refresh).toHaveBeenCalledOnce()

    store.isRefreshing = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find(".refresh-performance").attributes("disabled")).toBeDefined()
  })
})
