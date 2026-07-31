import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import DisplaySettings from "./DisplaySettings.vue"
import { rpcSuccess, settingsSnapshot, testBootstrap, testSettings } from "../../test/ipc"

describe("DisplaySettings", () => {
  beforeEach(() => {
    const initial = testSettings({ swapDirectory: "C:/swap", theme: "dark" })
    window.yadaw.bootstrap = vi
      .fn()
      .mockResolvedValue(rpcSuccess(testBootstrap({ settings: settingsSnapshot(initial) })))
    window.yadaw.updateApplicationSettings = vi
      .fn()
      .mockImplementation(async (_meta, patch) =>
        rpcSuccess(settingsSnapshot(testSettings({ ...initial, ...patch }), 2))
      )
  })

  it("persists a theme selected by the user", async () => {
    const wrapper = mount(DisplaySettings, {
      global: { plugins: [createPinia()] }
    })
    await flushPromises()

    const lightOption = wrapper
      .findAll('[role="radio"]')
      .find((option) => option.text().includes("Light"))
    expect(lightOption).toBeDefined()
    await lightOption!.trigger("click")
    await flushPromises()

    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledWith(expect.any(Object), {
      theme: "light"
    })
    expect(lightOption!.attributes("aria-checked")).toBe("true")
  })

  it("persists a locale selected by the user", async () => {
    const wrapper = mount(DisplaySettings, {
      global: { plugins: [createPinia()] }
    })
    await flushPromises()

    const chineseOption = wrapper
      .findAll('[role="radio"]')
      .find((option) => option.text().includes("简体中文"))
    expect(chineseOption).toBeDefined()
    await chineseOption!.trigger("click")
    await flushPromises()

    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledWith(expect.any(Object), {
      locale: "zh-cmn-Hans-CN"
    })
    expect(chineseOption!.attributes("aria-checked")).toBe("true")
  })
})
