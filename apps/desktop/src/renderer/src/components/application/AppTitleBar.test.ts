import { shallowMount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import AppTitleBar from "./AppTitleBar.vue"
import ApplicationMenuBar from "./ApplicationMenuBar.vue"
import AppWindowControls from "./AppWindowControls.vue"

const menus = [
  {
    value: "file",
    label: "File",
    items: [{ value: "project.open", label: "Open Project…" }]
  }
]

describe("AppTitleBar", () => {
  it("shows the in-app menu on Windows and exposes unsaved project state", () => {
    const wrapper = shallowMount(AppTitleBar, {
      props: {
        platform: "win32",
        menus,
        projectName: "Night Session",
        dirty: true
      }
    })

    expect(wrapper.findComponent(ApplicationMenuBar).exists()).toBe(true)
    expect(wrapper.findComponent(AppWindowControls).exists()).toBe(true)
    expect(wrapper.text()).toContain("Night Session")
    expect(wrapper.get('[aria-label="Unsaved changes"]').attributes("title")).toBe(
      "Unsaved changes"
    )
  })

  it("keeps the custom title bar but omits the in-app menu on macOS", () => {
    const wrapper = shallowMount(AppTitleBar, {
      props: {
        platform: "darwin",
        menus,
        projectName: null,
        dirty: false
      }
    })

    expect(wrapper.attributes("data-platform")).toBe("darwin")
    expect(wrapper.findComponent(ApplicationMenuBar).exists()).toBe(false)
    expect(wrapper.findComponent(AppWindowControls).exists()).toBe(false)
    expect(wrapper.text()).toContain("No project open")
  })
})
