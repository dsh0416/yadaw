import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import ProjectSettingsPage from "./ProjectSettingsPage.vue"

const configuration = {
  name: "Untitled project",
  sampleRate: 48_000 as const,
  tempo: 120,
  timeSignatureNumerator: 4,
  timeSignatureDenominator: 4
}

describe("ProjectSettingsPage", () => {
  it("edits project configuration through its route-page form", async () => {
    const wrapper = mount(ProjectSettingsPage, {
      props: { configuration, saving: false, error: "", saved: false }
    })
    await wrapper.get('input[required]').setValue("Session")
    await wrapper.get("select").setValue("44100")
    await wrapper.findAll('input[type="number"]')[0]!.setValue("132.5")
    await wrapper.get("form").trigger("submit")

    expect(wrapper.emitted("save")?.[0]?.[0]).toMatchObject({
      name: "Session",
      sampleRate: 44_100,
      tempo: 132.5
    })
  })

  it("provides a back-to-studio action instead of a modal cancel action", async () => {
    const wrapper = mount(ProjectSettingsPage, {
      props: { configuration, saving: false, error: "", saved: false }
    })
    await wrapper.get(".back-button").trigger("click")
    expect(wrapper.emitted("close")).toHaveLength(1)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
})
