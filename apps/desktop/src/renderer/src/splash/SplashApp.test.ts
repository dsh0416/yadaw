import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { describe, expect, it, vi } from "vitest"
import type { StartupProgressSnapshot } from "@yadaw/contracts"
import SplashApp from "./SplashApp.vue"

describe("SplashApp", () => {
  it("renders the startup snapshot and live VST3 scan progress", async () => {
    const listeners: Array<(progress: StartupProgressSnapshot) => void> = []
    const startupProgressSnapshot = vi.fn(async (): Promise<StartupProgressSnapshot> => ({
      phase: "loading-catalog",
      progress: 0.1,
      label: "Loading plug-in catalog",
      detail: "Reading the previous VST3 index",
      completed: null,
      total: null,
      warnings: 0
    }))
    const subscribeStartupProgress = vi.fn((next: (progress: StartupProgressSnapshot) => void) => {
      listeners.push(next)
      return vi.fn()
    })
    Object.defineProperty(window, "yadaw", {
      configurable: true,
      value: {
        startupProgressSnapshot,
        subscribeStartupProgress
      }
    })
    setActivePinia(createPinia())

    const wrapper = mount(SplashApp)
    await flushPromises()
    expect(wrapper.text()).toContain("Loading plug-in catalog")
    expect(wrapper.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("10")

    listeners[0]?.({
      phase: "scanning-plugins",
      progress: 0.5,
      label: "Scanning VST3 plug-ins",
      detail: "Super Synth.vst3",
      completed: 4,
      total: 10,
      warnings: 1
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain("Scanning VST3 plug-ins")
    expect(wrapper.text()).toContain("Super Synth.vst3")
    expect(wrapper.text()).toContain("4 / 10")
    expect(wrapper.text()).toContain("1 plug-ins quarantined")
    expect(wrapper.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("50")
  })
})
