import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import SettingsPage from "./SettingsPage.vue"
import SettingsSection from "./SettingsSection.vue"

describe("settings content primitives", () => {
  it("renders a page path, description and setting section content", () => {
    const wrapper = mount(SettingsPage, {
      props: {
        category: "Project",
        page: "General",
        title: "Project identity",
        description: "Settings stored with this project."
      },
      slots: {
        default:
          '<SettingsSection eyebrow="Identity" title="Project name" description="Shown in the workspace."><label>Name<input aria-label="Name"></label></SettingsSection>'
      },
      global: {
        components: { SettingsSection }
      }
    })

    expect(wrapper.get("h2").text()).toBe("Project identity")
    expect(wrapper.text()).toContain("Project / General")
    expect(wrapper.text()).toContain("Shown in the workspace.")
    expect(wrapper.get('input[aria-label="Name"]').attributes("aria-label")).toBe("Name")
  })
})
