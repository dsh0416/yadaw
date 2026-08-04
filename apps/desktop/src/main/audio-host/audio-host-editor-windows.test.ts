import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  BaseWindow: class {},
  WebContentsView: class {},
  screen: {
    getDisplayMatching: () => ({ scaleFactor: 1 })
  }
}))

import { nativeExtent } from "./audio-host-editor-windows"

describe("native plug-in editor dimensions", () => {
  it("keeps AppKit dimensions in logical points", () => {
    expect(nativeExtent(640, 480, 2, "darwin")).toEqual({ width: 640, height: 480 })
  })

  it("converts Electron logical pixels to Win32 and X11 pixels", () => {
    expect(nativeExtent(640, 480, 1.5, "win32")).toEqual({ width: 960, height: 720 })
    expect(nativeExtent(640, 480, 2, "linux")).toEqual({ width: 1280, height: 960 })
  })

  it("never registers an empty native child surface", () => {
    expect(nativeExtent(0, 0, 0, "linux")).toEqual({ width: 1, height: 1 })
  })
})
