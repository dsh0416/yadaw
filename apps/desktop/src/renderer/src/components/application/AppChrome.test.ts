import { flushPromises, shallowMount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AppChrome from "./AppChrome.vue"
import AppTitleBar from "./AppTitleBar.vue"

const applicationCommands = vi.hoisted(() => ({
  execute: vi.fn()
}))

vi.mock("../../composables/useApplicationCommands", () => ({
  useApplicationCommands: () => ({
    platform: "win32",
    menus: [],
    execute: applicationCommands.execute
  })
}))

describe("AppChrome", () => {
  beforeEach(() => applicationCommands.execute.mockReset())

  it("routes the title-bar close button through the application command workflow", async () => {
    const wrapper = shallowMount(AppChrome, {
      global: { plugins: [createPinia()] }
    })

    wrapper.findComponent(AppTitleBar).vm.$emit("windowCommand", "window.close")
    await flushPromises()

    expect(applicationCommands.execute).toHaveBeenCalledWith("window.close")
  })
})
