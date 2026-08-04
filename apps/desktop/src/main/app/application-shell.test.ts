import { describe, expect, it, vi } from "vitest"
import {
  APPLICATION_ID,
  APPLICATION_NAME,
  configureApplicationIdentity,
  quitWhenAllWindowsAreClosed
} from "./application-shell"

function applicationIdentity() {
  return {
    commandLine: { appendSwitch: vi.fn() },
    setAppUserModelId: vi.fn(),
    setName: vi.fn()
  }
}

describe("application shell", () => {
  it.each<NodeJS.Platform>(["darwin", "linux", "win32"])(
    "uses the product name on %s",
    (platform) => {
      const application = applicationIdentity()

      configureApplicationIdentity(application, platform)

      expect(application.setName).toHaveBeenCalledWith(APPLICATION_NAME)
    }
  )

  it("registers the Windows application identity", () => {
    const application = applicationIdentity()

    configureApplicationIdentity(application, "win32")

    expect(application.setAppUserModelId).toHaveBeenCalledWith(APPLICATION_ID)
    expect(application.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it("registers the Linux desktop class", () => {
    const application = applicationIdentity()

    configureApplicationIdentity(application, "linux")

    expect(application.commandLine.appendSwitch).toHaveBeenCalledWith("class", APPLICATION_ID)
    expect(application.setAppUserModelId).not.toHaveBeenCalled()
  })

  it("quits after the last window closes on every platform", () => {
    const listeners = new Map<string, () => void>()
    const application = {
      on: vi.fn((event: "window-all-closed", listener: () => void) => {
        listeners.set(event, listener)
      }),
      quit: vi.fn()
    }

    quitWhenAllWindowsAreClosed(application)
    listeners.get("window-all-closed")?.()

    expect(application.quit).toHaveBeenCalledOnce()
  })
})
