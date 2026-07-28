import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { defineComponent, h } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApplicationCommandId, ProjectSession } from "@yadaw/contracts"
import { useApplicationCommands } from "./useApplicationCommands"
import { useGlobalDialog } from "./useGlobalDialog"
import { useProjectStore } from "../stores/project"

const session: ProjectSession = {
  id: "project",
  path: "session.yadaw",
  configuration: {
    name: "Session",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

function createHarness() {
  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "welcome", component: { template: "<div />" } },
      { path: "/studio", name: "studio", component: { template: "<div />" } },
      {
        path: "/settings/project",
        name: "project-settings",
        component: { template: "<div />" }
      },
      {
        path: "/settings/system",
        name: "system-settings",
        component: { template: "<div />" }
      }
    ]
  })
  const Harness = defineComponent({
    setup() {
      const { execute } = useApplicationCommands()
      const button = (command: ApplicationCommandId, label: string) =>
        h("button", { type: "button", onClick: () => execute(command) }, label)
      return () =>
        h("div", [
          button("application.preferences", "Preferences"),
          button("project.settings", "Project settings")
        ])
    }
  })
  const wrapper = mount(Harness, {
    global: { plugins: [pinia, router] }
  })
  return { pinia, router, wrapper }
}

describe("useApplicationCommands", () => {
  let nativeCommandListener: ((command: ApplicationCommandId) => void) | null

  beforeEach(() => {
    vi.clearAllMocks()
    nativeCommandListener = null
    Object.defineProperty(window.yadaw, "platform", {
      configurable: true,
      value: "win32"
    })
    window.yadaw.subscribeApplicationCommands = vi.fn((listener) => {
      nativeCommandListener = listener
      return () => undefined
    })
    window.yadaw.transportCommand = vi.fn().mockResolvedValue({
      state: "stopped",
      positionFrames: 0,
      sampleRate: 48_000
    })
  })

  it("opens application preferences without requiring a project", async () => {
    const { router, wrapper } = createHarness()

    await wrapper.get("button:nth-of-type(1)").trigger("click")
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("system-settings")
  })

  it("opens project settings only while a project is open", async () => {
    const { pinia, router, wrapper } = createHarness()

    await wrapper.get("button:nth-of-type(2)").trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.name).not.toBe("project-settings")

    useProjectStore(pinia).applyLifecycleState({
      status: "open",
      session,
      error: null
    })
    await wrapper.get("button:nth-of-type(2)").trigger("click")
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("project-settings")
  })

  it("routes macOS system-menu commands through the same command dispatcher", async () => {
    const { router } = createHarness()

    nativeCommandListener?.("application.preferences")
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("system-settings")
  })

  it.each(["window.close", "application.quit"] as const)(
    "prompts before %s and continues only after the dirty project is closed",
    async (command) => {
      window.yadaw.closeProject = vi.fn().mockResolvedValue(true)
      const { pinia } = createHarness()
      useProjectStore(pinia).applyLifecycleState({
        status: "open",
        session: { ...session, dirty: true },
        error: null
      })
      const { activeDialog, selectDialogAction } = useGlobalDialog()

      nativeCommandListener?.(command)
      await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
      expect(window.yadaw.executeApplicationWindowCommand).not.toHaveBeenCalledWith(command)
      selectDialogAction("discard")
      await flushPromises()

      expect(window.yadaw.closeProject).toHaveBeenCalledWith("discard")
      expect(window.yadaw.executeApplicationWindowCommand).toHaveBeenCalledWith(command)
    }
  )

  it("keeps the current dirty project when switching projects is cancelled", async () => {
    window.yadaw.prepareOpenProject = vi.fn()
    const { pinia } = createHarness()
    const projectStore = useProjectStore(pinia)
    projectStore.applyLifecycleState({
      status: "open",
      session: { ...session, dirty: true },
      error: null
    })
    const { activeDialog, dismissDialog } = useGlobalDialog()

    nativeCommandListener?.("project.open")
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    dismissDialog()
    await flushPromises()

    expect(window.yadaw.closeProject).not.toHaveBeenCalled()
    expect(window.yadaw.prepareOpenProject).not.toHaveBeenCalled()
    expect(projectStore.session?.path).toBe(session.path)
  })
})
