import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import ProjectSettingsPage from "./ProjectSettingsPage.vue"

const configuration = {
  name: "Untitled project",
  sampleRate: 48_000 as const,
  timeSignatureNumerator: 4,
  timeSignatureDenominator: 4,
  waveformDisplayMode: "separate" as const
}

describe("ProjectSettingsPage", () => {
  it("edits project configuration through its route-page form", async () => {
    const wrapper = mount(ProjectSettingsPage, {
      props: { configuration, saving: false, error: "", saved: false }
    })

    await wrapper.get("input[required]").setValue("Session")
    await wrapper.get("select").setValue("44100")
    await wrapper.findAll('input[type="number"]')[0]!.setValue("7")
    await wrapper.findAll("select").at(-1)!.setValue("aggregate")
    await wrapper.get("form").trigger("submit")

    expect(wrapper.emitted("save")?.[0]?.[0]).toMatchObject({
      name: "Session",
      sampleRate: 44_100,
      timeSignatureNumerator: 7,
      waveformDisplayMode: "aggregate"
    })
    expect(wrapper.findAll("label > span").map((field) => field.text())).not.toContain("Tempo")
  })

  it("provides shared two-level navigation and a back-to-studio action", async () => {
    const wrapper = mount(ProjectSettingsPage, {
      props: { configuration, saving: false, error: "", saved: false }
    })

    expect(wrapper.get('nav[aria-label="Project settings categories"]').text()).toContain("Timing")
    expect(wrapper.get('nav[aria-label="Project settings pages"]').text()).toContain("General")
    await wrapper.get('button[aria-label="Back to studio"]').trigger("click")

    expect(wrapper.emitted("close")).toHaveLength(1)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
})
