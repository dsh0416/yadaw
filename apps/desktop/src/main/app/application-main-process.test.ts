import { describe, expect, it, vi } from "vitest"
import type { App } from "electron"
import type { StartedApplicationServices } from "./startup"
import { startMainProcess } from "./application-main-process"

function harness({ testUserData }: { testUserData?: string } = {}) {
  let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined
  let captureServices: ((services: StartedApplicationServices) => void) | undefined
  let isShuttingDown: (() => boolean) | undefined
  const application = {
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    on: vi.fn((event: string, listener: typeof beforeQuit) => {
      if (event === "before-quit") beforeQuit = listener
    }),
    quit: vi.fn(),
    setPath: vi.fn()
  } as unknown as App
  const dependencies = {
    configureApplicationIdentity: vi.fn(),
    deferProjectClose: vi.fn(() => false),
    mainWindow: vi.fn(() => null),
    quitWhenAllWindowsAreClosed: vi.fn(),
    registerRendererScheme: vi.fn(),
    startApplication: vi.fn(
      (shutdownState: () => boolean, capture: (services: StartedApplicationServices) => void) => {
        isShuttingDown = shutdownState
        captureServices = capture
      }
    )
  }
  startMainProcess(
    application,
    "linux",
    testUserData ? { HERON_TEST_USER_DATA: testUserData } : {},
    dependencies
  )
  return {
    application,
    beforeQuit: (event: { preventDefault(): void }) => beforeQuit?.(event),
    captureServices: (services: StartedApplicationServices) => captureServices?.(services),
    dependencies,
    isShuttingDown: () => isShuttingDown?.()
  }
}

describe("main process", () => {
  it("configures the shell and isolated user data for test launches", () => {
    const { application, dependencies } = harness({ testUserData: "/tmp/heron-test" })

    expect(dependencies.configureApplicationIdentity).toHaveBeenCalledWith(application, "linux")
    expect(dependencies.registerRendererScheme).toHaveBeenCalledOnce()
    expect(dependencies.quitWhenAllWindowsAreClosed).toHaveBeenCalledWith(application)
    expect(application.disableHardwareAcceleration).toHaveBeenCalledOnce()
    expect(application.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu")
    expect(application.setPath).toHaveBeenCalledWith("userData", "/tmp/heron-test")
  })

  it("defers shutdown while the current project owns the close decision", () => {
    const { application, beforeQuit, captureServices, dependencies, isShuttingDown } = harness()
    const project = { id: "project-1" }
    captureServices({
      projectService: { current: project }
    } as unknown as StartedApplicationServices)
    dependencies.deferProjectClose.mockReturnValue(true)
    const event = { preventDefault: vi.fn() }

    beforeQuit(event)

    expect(dependencies.deferProjectClose).toHaveBeenCalledWith(
      expect.objectContaining({ command: "application.quit", project })
    )
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(isShuttingDown()).toBe(false)
    expect(application.quit).not.toHaveBeenCalled()
  })

  it("disposes services once and quits after asynchronous shutdown settles", async () => {
    const { application, beforeQuit, captureServices, isShuttingDown } = harness()
    const services = {
      dispose: vi.fn(),
      audioHostService: {
        stopAudioEngine: vi.fn().mockRejectedValue(new Error("already stopped")),
        stop: vi.fn().mockResolvedValue(undefined)
      },
      projectService: {
        current: null,
        shutdown: vi.fn().mockRejectedValue(new Error("project cleanup failed"))
      }
    }
    captureServices(services as unknown as StartedApplicationServices)
    const event = { preventDefault: vi.fn() }

    beforeQuit(event)
    beforeQuit(event)
    expect(isShuttingDown()).toBe(true)
    await vi.waitFor(() => expect(application.quit).toHaveBeenCalledOnce())

    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(services.dispose).toHaveBeenCalledOnce()
    expect(services.audioHostService.stopAudioEngine).toHaveBeenCalledOnce()
    expect(services.audioHostService.stop).toHaveBeenCalledOnce()
    expect(services.projectService.shutdown).toHaveBeenCalledOnce()

    beforeQuit(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
  })

  it("can quit before application services have started", async () => {
    const { application, beforeQuit } = harness()

    beforeQuit({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(application.quit).toHaveBeenCalledOnce())
  })
})
