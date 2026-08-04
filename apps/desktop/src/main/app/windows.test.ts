import { beforeEach, describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  isPackaged: false
}))

vi.mock("electron", () => ({
  app: electron,
  BrowserWindow: class {},
  shell: { openExternal: electron.openExternal }
}))

import { mainWindowPlatformOptions, openExternalUrl, secureWebPreferences } from "./windows"

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
