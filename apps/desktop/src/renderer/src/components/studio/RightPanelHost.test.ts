import { enableAutoUnmount, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, describe, expect, it, vi } from "vitest"
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

  it("resizes with a captured pointer until the pointer is released", async () => {
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
    const separator = wrapper.get<HTMLElement>('[role="separator"]')
    const capture = vi.fn()
    separator.element.setPointerCapture = capture
    const originalWidth = window.innerWidth
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 })

    await separator.trigger("pointerdown", { pointerId: 7 })
    expect(capture).toHaveBeenCalledWith(7)
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 600 }))
    expect(workspace.rightPanelWidth).toBe(400)

    window.dispatchEvent(new PointerEvent("pointerup"))
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 700 }))
    expect(workspace.rightPanelWidth).toBe(400)
    await separator.trigger("keydown", { key: "End" })
    expect(workspace.rightPanelWidth).toBe(400)

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth })
  })
})
