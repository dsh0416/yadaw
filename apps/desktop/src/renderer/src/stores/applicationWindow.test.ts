import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApplicationCommandId } from "@heron/contracts"
import { useApplicationWindowStore } from "./applicationWindow"
import { useProjectStore } from "./project"
import { testBootstrap } from "../test/ipc"

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.heron as unknown as Record<string, unknown>, overrides)
}

beforeEach(() => {
  setActivePinia(createPinia())
  useProjectStore().applyBootstrap(testBootstrap())
})

describe("useApplicationWindowStore", () => {
  it("exposes the desktop platform from the preload bridge", () => {
    stubApi({ platform: "linux" })
    const store = useApplicationWindowStore()

    expect(store.platform).toBe("linux")
  })

  it("forwards application commands from the preload event stream", () => {
    const listeners: Array<(command: ApplicationCommandId) => void> = []
    stubApi({
      subscribeApplicationCommands: (
        listener: (event: { payload: ApplicationCommandId }) => void
      ) => {
        listeners.push((command) => listener({ payload: command }))
        return () => {
          listeners.length = 0
        }
      }
    })
    const store = useApplicationWindowStore()
    const received: ApplicationCommandId[] = []
    const unsubscribe = store.subscribeCommands((command) => received.push(command))

    listeners[0]?.("project.save")
    unsubscribe()

    expect(received).toEqual(["project.save"])
  })

  it("dispatches window commands against the desktop session", async () => {
    const executeApplicationWindowCommand = vi.fn(async () => ({ ok: true }))
    stubApi({ executeApplicationWindowCommand })
    const store = useApplicationWindowStore()

    await store.execute("window.minimize")

    expect(executeApplicationWindowCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        target: testBootstrap().desktopSession,
        mutation: expect.objectContaining({
          operationId: expect.stringContaining("application-window-window.minimize")
        })
      }),
      "window.minimize"
    )
  })

  it("sets the native window theme through the desktop session", async () => {
    const setApplicationWindowTheme = vi.fn(async () => ({ ok: true }))
    stubApi({ setApplicationWindowTheme })
    const store = useApplicationWindowStore()

    await store.setTheme("dark")

    expect(setApplicationWindowTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        target: testBootstrap().desktopSession,
        mutation: expect.objectContaining({
          operationId: expect.stringContaining("application-window-theme")
        })
      }),
      "dark"
    )
  })

  it("ignores window commands when the desktop session is unavailable", async () => {
    const executeApplicationWindowCommand = vi.fn(async () => ({ ok: true }))
    stubApi({ executeApplicationWindowCommand })
    useProjectStore().desktopSession = null
    const store = useApplicationWindowStore()

    await store.execute("window.minimize")

    expect(executeApplicationWindowCommand).not.toHaveBeenCalled()
  })
})
