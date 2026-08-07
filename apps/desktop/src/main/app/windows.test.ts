import { beforeEach, describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  isPackaged: false,
  instances: [] as Array<{
    options: Record<string, unknown>
    events: Map<string, (...args: unknown[]) => unknown>
    webEvents: Map<string, (...args: unknown[]) => unknown>
    destroyed: boolean
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    loadURL: ReturnType<typeof vi.fn>
    webContents: Record<string, unknown>
  }>
}))

vi.mock("electron", () => ({
  app: electron,
  BrowserWindow: class {
    options: Record<string, unknown>
    events = new Map<string, (...args: unknown[]) => unknown>()
    webEvents = new Map<string, (...args: unknown[]) => unknown>()
    destroyed = false
    show = vi.fn()
    focus = vi.fn()
    loadURL = vi.fn(async () => undefined)
    webContents = {
      setWindowOpenHandler: vi.fn((handler) =>
        this.webEvents.set("window-open", handler as (...args: unknown[]) => unknown)
      ),
      on: vi.fn((event, handler) =>
        this.webEvents.set(event, handler as (...args: unknown[]) => unknown)
      )
    }
    constructor(options: Record<string, unknown>) {
      this.options = options
      electron.instances.push(this)
    }
    on(event: string, handler: (...args: unknown[]) => unknown) {
      this.events.set(event, handler)
    }
    once(event: string, handler: (...args: unknown[]) => unknown) {
      this.events.set(event, handler)
    }
    isDestroyed() {
      return this.destroyed
    }
  },
  shell: { openExternal: electron.openExternal }
}))

import {
  createMainWindow,
  createSplashWindow,
  mainWindow,
  mainWindowPlatformOptions,
  openExternalUrl,
  secureWebPreferences,
  splashWindow
} from "./windows"

describe("openExternalUrl", () => {
  beforeEach(() => electron.openExternal.mockClear())

  it("opens only the two exact product links", () => {
    expect(openExternalUrl("https://heron.minori.live/manual/")).toBe(true)
    expect(openExternalUrl("https://github.com/minori-live/heron")).toBe(true)
    expect(openExternalUrl("http://heron.minori.live/manual/")).toBe(false)
    expect(openExternalUrl("https://heron.minori.live/manual/extra")).toBe(false)
    expect(openExternalUrl("https://heron.minori.live/manual/?source=app")).toBe(false)
    expect(openExternalUrl("https://heron.minori.live/manual/#install")).toBe(false)
    expect(openExternalUrl("https://heron.minori.live.evil.example/manual/")).toBe(false)
    expect(openExternalUrl("javascript:alert(1)")).toBe(false)
    expect(openExternalUrl("file:///tmp/session.heron")).toBe(false)
    expect(openExternalUrl("not a url")).toBe(false)

    expect(electron.openExternal).toHaveBeenCalledTimes(2)
  })
})

describe("mainWindowPlatformOptions", () => {
  it("dispatches the first mixer click after a macOS native plug-in editor was active", () => {
    expect(mainWindowPlatformOptions("darwin")).toMatchObject({
      titleBarStyle: "hiddenInset",
      acceptFirstMouse: true,
      trafficLightPosition: { x: 12, y: 11 }
    })
  })

  it("does not opt other platforms into macOS first-mouse behavior", () => {
    expect(mainWindowPlatformOptions("win32")).not.toHaveProperty("acceptFirstMouse")
    expect(mainWindowPlatformOptions("linux")).not.toHaveProperty("acceptFirstMouse")
  })
})

describe("secureWebPreferences", () => {
  it("explicitly disables privileged renderer features", () => {
    expect(secureWebPreferences()).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false
    })
  })
})

describe("window lifecycle", () => {
  beforeEach(() => electron.instances.splice(0))

  it("creates, secures, reveals, and releases the splash window", () => {
    const created = createSplashWindow() as unknown as (typeof electron.instances)[number]
    expect(created.options).toMatchObject({ show: false, width: 620, height: 360, frame: false })
    expect(created.loadURL).toHaveBeenCalledOnce()
    expect(splashWindow).toBe(created)

    const preventDefault = vi.fn()
    created.webEvents.get("will-navigate")!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    created.events.get("ready-to-show")!()
    expect(created.show).toHaveBeenCalledOnce()
    created.events.get("closed")!()
    expect(splashWindow).toBeNull()
  })

  it("reuses the live main window and recreates it after close", () => {
    const first = createMainWindow(false) as unknown as (typeof electron.instances)[number]
    expect(first.options).toMatchObject({ show: false, width: 1440, height: 900 })
    expect(first.loadURL).not.toHaveBeenCalled()
    expect(mainWindow).toBe(first)

    expect(createMainWindow()).toBe(first)
    expect(first.show).toHaveBeenCalledOnce()
    expect(first.focus).toHaveBeenCalledOnce()

    const open = first.webEvents.get("window-open")!({
      url: "https://heron.minori.live/manual/"
    })
    expect(open).toEqual({ action: "deny" })
    const preventDefault = vi.fn()
    first.webEvents.get("will-navigate")!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()

    first.events.get("closed")!()
    expect(mainWindow).toBeNull()
    const second = createMainWindow() as unknown as (typeof electron.instances)[number]
    expect(second).not.toBe(first)
    expect(second.loadURL).toHaveBeenCalledOnce()
  })
})
