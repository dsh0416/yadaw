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
import { setMainLocale } from "./i18n"

describe("installApplicationMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMainLocale("en-US")
  })

  it("installs the macOS menu with preferences, project settings, and Help diagnostics", () => {
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
    const effectGraph = help?.submenu?.find(
      (item: { label?: string }) => item.label === "Effect Chain Graph…"
    )

    preferences?.click()
    projectSettings?.click()
    benchmark?.click()
    effectGraph?.click()

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
    expect(electron.send).toHaveBeenNthCalledWith(
      4,
      IPC_CHANNELS.applicationCommandRequested,
      "help.effect-chain-graph"
    )
    expect(benchmark).toBeDefined()
    expect(effectGraph).toBeDefined()
    expect(electron.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it("rebuilds the macOS menu with Chinese labels after locale change", () => {
    setMainLocale("zh-cmn-Hans-CN")
    installApplicationMenu("darwin")

    const template = electron.buildFromTemplate.mock.calls[0]?.[0]
    const file = template?.find((item: { label?: string }) => item.label === "文件")
    const preferences = template
      ?.find((item: { label?: string }) => item.label === "YADAW")
      ?.submenu?.find((item: { label?: string }) => item.label === "偏好设置…")

    expect(file).toBeDefined()
    expect(preferences).toBeDefined()
  })

  it("uses configured keyboard bindings for native menu accelerators", () => {
    installApplicationMenu("darwin", {
      keyboard: {
        "project.save": { code: "KeyK", modifiers: ["primary", "shift"] }
      },
      midi: {}
    })

    const template = electron.buildFromTemplate.mock.calls[0]?.[0]
    const save = template
      ?.find((item: { label?: string }) => item.label === "File")
      ?.submenu?.find((item: { label?: string }) => item.label === "Save Project")
    expect(save?.accelerator).toBe("Command+Shift+K")
  })

  it("removes the Electron application menu on Windows and Linux", () => {
    installApplicationMenu("win32")

    expect(electron.buildFromTemplate).not.toHaveBeenCalled()
    expect(electron.setApplicationMenu).toHaveBeenCalledWith(null)
  })
})
