import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { defineComponent, h } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApplicationCommandId, ProjectSession } from "@yadaw/contracts"
import { useApplicationCommands } from "./useApplicationCommands"
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
    nativeCommandListener = null
    Object.defineProperty(window.yadaw, "platform", {
      configurable: true,
      value: "win32"
    })
    window.yadaw.subscribeApplicationCommands = vi.fn((listener) => {
      nativeCommandListener = listener
      return () => undefined
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
})
