import { beforeEach, describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template) => template),
  setApplicationMenu: vi.fn(),
  showAboutPanel: vi.fn(),
  send: vi.fn(),
  show: vi.fn()
}))

vi.mock("electron", () => ({
  app: { showAboutPanel: electron.showAboutPanel },
  BrowserWindow: {
    getFocusedWindow: () => ({
      show: electron.show,
      webContents: { send: electron.send }
    }),
    getAllWindows: () => []
  },
  Menu: {
    buildFromTemplate: electron.buildFromTemplate,
    setApplicationMenu: electron.setApplicationMenu
  }
}))

import { IPC_CHANNELS } from "@yadaw/contracts"
import { installApplicationMenu } from "./application-menu"

describe("installApplicationMenu", () => {
  beforeEach(() => vi.clearAllMocks())

  it("places the audio benchmark inside the Help menu", () => {
    installApplicationMenu()

    const template = electron.buildFromTemplate.mock.calls[0]?.[0]
    const help = template?.find((item: { role?: string }) => item.role === "help")
    const benchmark = help?.submenu?.find(
      (item: { label?: string }) => item.label === "Audio Performance Benchmark…"
    )

    expect(benchmark).toBeDefined()
    benchmark?.click()
    expect(electron.send).toHaveBeenCalledWith(IPC_CHANNELS.audioBenchmarkMenuOpen)
    expect(electron.setApplicationMenu).toHaveBeenCalledOnce()
  })
})
