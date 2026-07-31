import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MidiSettings from "./MidiSettings.vue"
import { rpcSuccess, settingsSnapshot, testBootstrap, testSettings } from "../../test/ipc"

describe("MidiSettings", () => {
  beforeEach(() => {
    const initial = testSettings({
      swapDirectory: "C:/swap",
      theme: "dark",
      midiCenterCStandard: "roland-c4"
    })
    window.yadaw.bootstrap = vi
      .fn()
      .mockResolvedValue(rpcSuccess(testBootstrap({ settings: settingsSnapshot(initial) })))
    window.yadaw.updateApplicationSettings = vi
      .fn()
      .mockImplementation(async (_meta, patch) =>
        rpcSuccess(settingsSnapshot(testSettings({ ...initial, ...patch }), 2))
      )
  })

  it("persists the Yamaha center C standard selected by the user", async () => {
    const wrapper = mount(MidiSettings, {
      global: { plugins: [createPinia()] }
    })
    await flushPromises()

    const yamahaOption = wrapper
      .findAll('[role="radio"]')
      .find((option) => option.text().includes("Yamaha (C3)"))
    expect(yamahaOption).toBeDefined()
    expect(
      wrapper
        .findAll('[role="radio"]')
        .find((option) => option.text().includes("Roland (C4)"))
        ?.attributes("aria-checked")
    ).toBe("true")

    await yamahaOption!.trigger("click")
    await flushPromises()

    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledWith(expect.any(Object), {
      midiCenterCStandard: "yamaha-c3"
    })
    expect(yamahaOption!.attributes("aria-checked")).toBe("true")
  })
})
