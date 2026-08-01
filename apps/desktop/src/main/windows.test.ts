import { beforeEach, describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined)
}))

vi.mock("electron", () => ({
  BrowserWindow: class {},
  shell: { openExternal: electron.openExternal }
}))

import { openExternalUrl } from "./windows"

describe("openExternalUrl", () => {
  beforeEach(() => electron.openExternal.mockClear())

  it("opens web links in the operating system and rejects unsafe protocols", () => {
    expect(openExternalUrl("https://yadaw.minori.live/manual/")).toBe(true)
    expect(openExternalUrl("javascript:alert(1)")).toBe(false)
    expect(openExternalUrl("file:///tmp/session.yadaw")).toBe(false)
    expect(openExternalUrl("not a url")).toBe(false)

    expect(electron.openExternal).toHaveBeenCalledOnce()
    expect(electron.openExternal).toHaveBeenCalledWith("https://yadaw.minori.live/manual/")
  })
})
