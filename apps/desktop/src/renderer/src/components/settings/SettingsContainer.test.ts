import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { AudioLines, Gauge, Palette } from "@lucide/vue"
import SettingsContainer from "./SettingsContainer.vue"
import type { SettingsCategory } from "./settings"

const categories: readonly SettingsCategory[] = [
  {
    id: "system",
    label: "System",
    description: "Runtime",
    icon: Gauge,
    pages: [
      {
        id: "engine",
        label: "Engine",
        description: "Worker scheduling",
        icon: Gauge
      }
    ]
  },
  {
    id: "audio",
    label: "Audio",
    description: "Signal path",
    icon: AudioLines,
    pages: [
      {
        id: "devices",
        label: "Devices",
        description: "Hardware input and output",
        icon: AudioLines
      }
    ]
  },
  {
    id: "display",
    label: "Display",
    description: "Workspace",
    icon: Palette,
    badge: "Soon",
    pages: []
  }
]

function mountContainer(activePage = "engine") {
  return mount(SettingsContainer, {
    props: {
      title: "System settings",
      scopeLabel: "Heron / System",
      backLabel: "Back to studio",
      categories,
      activePage
    },
    slots: {
      actions: '<button class="settings-action">Done</button>',
      default: "<p>Active settings content</p>"
    }
  })
}

describe("SettingsContainer", () => {
  it("renders the active category, its pages, actions and content", () => {
    const wrapper = mountContainer()

    expect(wrapper.get('nav[aria-label="System settings categories"]').text()).toContain("System")
    expect(wrapper.get('nav[aria-label="System settings pages"]').text()).toContain("Engine")
    expect(wrapper.get('button[aria-label="Back to studio"]').attributes("type")).toBe("button")
    expect(wrapper.text()).toContain("Done")
    expect(wrapper.text()).toContain("Active settings content")
    expect(wrapper.get('button[aria-current="page"]').text()).toContain("System")
  })

  it("selects the first enabled page in a category and ignores unavailable categories", async () => {
    const wrapper = mountContainer()
    const categoryNavigation = wrapper.get('nav[aria-label="System settings categories"]')
    const buttons = categoryNavigation.findAll("button")

    await buttons.find((button) => button.text().includes("Audio"))!.trigger("click")
    expect(wrapper.emitted("update:activePage")?.at(-1)).toEqual(["devices"])

    const display = buttons.find((button) => button.text().includes("Display"))!
    expect(display.attributes("disabled")).toBeDefined()
    await display.trigger("click")
    expect(wrapper.emitted("update:activePage")).toHaveLength(1)
  })

  it("falls back to the first available page and emits back", async () => {
    const wrapper = mountContainer("missing")

    expect(wrapper.emitted("update:activePage")?.[0]).toEqual(["engine"])
    await wrapper.get('button[aria-label="Back to studio"]').trigger("click")
    expect(wrapper.emitted("back")).toHaveLength(1)
  })
})
