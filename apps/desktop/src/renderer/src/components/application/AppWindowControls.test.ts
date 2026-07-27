import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import AppWindowControls from "./AppWindowControls.vue"

describe("AppWindowControls", () => {
  it("emits the restricted window command for each visible control", async () => {
    const wrapper = mount(AppWindowControls)

    await wrapper.get('button[aria-label="Minimize"]').trigger("click")
    await wrapper.get('button[aria-label="Maximize or restore"]').trigger("click")
    await wrapper.get('button[aria-label="Close"]').trigger("click")

    expect(wrapper.emitted("command")).toEqual([
      ["window.minimize"],
      ["window.toggle-maximize"],
      ["window.close"]
    ])
  })
})
