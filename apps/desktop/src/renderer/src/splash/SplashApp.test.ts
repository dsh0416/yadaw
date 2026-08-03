import { createHead } from "@unhead/vue/client"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { StartupProgressSnapshot } from "@heron/contracts"
import { describe, expect, it, vi } from "vitest"
import SplashApp from "./SplashApp.vue"
import { rpcEvent } from "../test/ipc"

describe("SplashApp", () => {
  it("renders the minimal brand and live startup progress", async () => {
    const listeners: Array<
      (progress: ReturnType<typeof rpcEvent<StartupProgressSnapshot>>) => void
    > = []
    const subscribeStartupProgress = vi.fn(
      (next: (progress: ReturnType<typeof rpcEvent<StartupProgressSnapshot>>) => void) => {
        listeners.push(next)
        return vi.fn()
      }
    )
    Object.defineProperty(window, "heron", {
      configurable: true,
      value: {
        subscribeStartupProgress
      }
    })
    setActivePinia(createPinia())

    const wrapper = mount(SplashApp, {
      global: {
        plugins: [createHead()]
      }
    })
    await flushPromises()
    listeners[0]?.(
      rpcEvent(
        {
          phase: "loading-catalog",
          progress: 0.1,
          label: "Loading plug-in catalog",
          detail: "Reading the previous VST3 index",
          completed: null,
          total: null,
          warnings: 0
        },
        1,
        "startup-epoch"
      )
    )
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain("https://github.com/dsh0416/heron")
    expect(wrapper.text()).toContain(`v${__APP_VERSION__}`)
    expect(wrapper.text()).toContain("Loading plug-in catalog")
    expect(wrapper.text()).not.toContain("Reading the previous VST3 index")
    expect(wrapper.findAll(".progress-track > i")).toHaveLength(0)
    expect(wrapper.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("10")

    listeners[0]?.(
      rpcEvent(
        {
          phase: "scanning-plugins",
          progress: 0.5,
          label: "Scanning VST3 plug-ins",
          detail: "Super Synth.vst3",
          completed: 4,
          total: 10,
          warnings: 1
        },
        2,
        "startup-epoch"
      )
    )
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain("Scanning VST3 plug-ins")
    expect(wrapper.text()).not.toContain("Super Synth.vst3")
    expect(wrapper.text()).not.toContain("4 / 10")
    expect(wrapper.text()).not.toContain("plug-ins quarantined")
    expect(wrapper.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("50")
  })
})
