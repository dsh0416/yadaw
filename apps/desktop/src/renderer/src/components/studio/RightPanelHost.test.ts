import { enableAutoUnmount, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, describe, expect, it } from "vitest"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import RightPanelHost from "./RightPanelHost.vue"

enableAutoUnmount(afterEach)

describe("RightPanelHost", () => {
  it("exposes bounded keyboard resizing and restores the default width", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const workspace = useStudioWorkspaceStore()
    workspace.toggleMediaBrowser()
    const wrapper = mount(RightPanelHost, {
      global: {
        plugins: [pinia],
        stubs: { MediaBrowserPanel: true, NotesPanel: true }
      }
    })
    const separator = wrapper.get('[role="separator"]')

    await separator.trigger("keydown", { key: "ArrowLeft" })
    expect(workspace.rightPanelWidth).toBe(330)
    await separator.trigger("keydown", { key: "ArrowRight" })
    expect(workspace.rightPanelWidth).toBe(320)
    workspace.setRightPanelWidth(460)
    await separator.trigger("keydown", { key: "Home" })
    expect(workspace.rightPanelWidth).toBe(320)
    expect(separator.attributes("aria-valuemin")).toBe("260")
    expect(separator.attributes("aria-valuemax")).toBe("480")
  })
})
