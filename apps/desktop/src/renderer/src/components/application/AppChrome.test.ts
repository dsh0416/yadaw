import { shallowMount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { describe, expect, it } from "vitest"
import AppChrome from "./AppChrome.vue"
import AppTitleBar from "./AppTitleBar.vue"

describe("AppChrome", () => {
  it("routes the title-bar close button through the application command workflow", async () => {
    const wrapper = shallowMount(AppChrome, {
      props: { platform: "win32", menus: [] },
      global: { plugins: [createPinia()] }
    })

    wrapper.findComponent(AppTitleBar).vm.$emit("windowCommand", "window.close")

    expect(wrapper.emitted("command")).toEqual([["window.close"]])
  })
})
