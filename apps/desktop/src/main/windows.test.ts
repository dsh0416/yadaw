import { beforeEach, describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined)
}))

vi.mock("electron", () => ({
  BrowserWindow: class {},
  shell: { openExternal: electron.openExternal }
}))

import { mainWindowPlatformOptions, openExternalUrl } from "./windows"

describe("openExternalUrl", () => {
  beforeEach(() => electron.openExternal.mockClear())

  it("opens web links in the operating system and rejects unsafe protocols", () => {
    expect(openExternalUrl("https://heron.minori.live/manual/")).toBe(true)
    expect(openExternalUrl("javascript:alert(1)")).toBe(false)
    expect(openExternalUrl("file:///tmp/session.heron")).toBe(false)
    expect(openExternalUrl("not a url")).toBe(false)

    expect(electron.openExternal).toHaveBeenCalledOnce()
    expect(electron.openExternal).toHaveBeenCalledWith("https://heron.minori.live/manual/")
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
