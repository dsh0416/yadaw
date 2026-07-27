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

  it("installs the macOS menu with preferences, project settings, and benchmark commands", () => {
    installApplicationMenu("darwin")

    const template = electron.buildFromTemplate.mock.calls[0]?.[0]
    const application = template?.find((item: { label?: string }) => item.label === "YADAW")
    const preferences = application?.submenu?.find(
      (item: { label?: string }) => item.label === "Preferences…"
    )
    const file = template?.find((item: { label?: string }) => item.label === "File")
    const projectSettings = file?.submenu?.find(
      (item: { label?: string }) => item.label === "Project Settings…"
    )
    const help = template?.find((item: { role?: string }) => item.role === "help")
    const benchmark = help?.submenu?.find(
      (item: { label?: string }) => item.label === "Audio Performance Benchmark…"
    )

    preferences?.click()
    projectSettings?.click()
    benchmark?.click()

    expect(electron.send).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.applicationCommandRequested,
      "application.preferences"
    )
    expect(electron.send).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.applicationCommandRequested,
      "project.settings"
    )
    expect(electron.send).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.applicationCommandRequested,
      "help.audio-benchmark"
    )
    expect(benchmark).toBeDefined()
    expect(electron.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it("removes the Electron application menu on Windows and Linux", () => {
    installApplicationMenu("win32")

    expect(electron.buildFromTemplate).not.toHaveBeenCalled()
    expect(electron.setApplicationMenu).toHaveBeenCalledWith(null)
  })
})
