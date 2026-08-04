import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  getAllWindows: vi.fn(() => []),
  fromWebContents: vi.fn(),
  shellOpenPath: vi.fn(async () => ""),
  quit: vi.fn(),
  showAboutPanel: vi.fn(),
  getPath: vi.fn(() => "/tmp/heron-test"),
  buildMenuFromTemplate: vi.fn(() => ({})),
  setApplicationMenu: vi.fn(),
  shouldUseDarkColors: false
}))

vi.mock("electron", () => ({
  app: {
    getPath: electronMocks.getPath,
    quit: electronMocks.quit,
    showAboutPanel: electronMocks.showAboutPanel
  },
  ipcMain: { handle: electronMocks.handle },
  dialog: {
    showSaveDialog: electronMocks.showSaveDialog,
    showOpenDialog: electronMocks.showOpenDialog
  },
  shell: { openPath: electronMocks.shellOpenPath },
  BrowserWindow: {
    getAllWindows: electronMocks.getAllWindows,
    fromWebContents: electronMocks.fromWebContents
  },
  Menu: {
    buildFromTemplate: electronMocks.buildMenuFromTemplate,
    setApplicationMenu: electronMocks.setApplicationMenu
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return electronMocks.shouldUseDarkColors
    }
  }
}))

import { IPC_CHANNELS } from "@heron/contracts"
import { createContext, defaultSettings, invoke, meta, mutationMeta } from "./test-harness"
import { registerSettingsRpcHandlers } from "./settings-rpc-handlers"

vi.mock("../app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app")>()),
  installApplicationMenu: vi.fn(),
  setMainLocale: vi.fn(),
  t: (key: string) => key
}))

describe("registerSettingsRpcHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
    electronMocks.showOpenDialog.mockReset()
    electronMocks.shellOpenPath.mockReset()
    electronMocks.shellOpenPath.mockResolvedValue("")
  })

  it("returns the settings snapshot for a matching read target", async () => {
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const settingsRef = context.lifecycle.applicationState.applicationSettings

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsGet,
      meta({ target: settingsRef })
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        settings: settingsRef,
        value: expect.objectContaining({ swapDirectory: "/swap" })
      }
    })
  })

  it("rejects settings get for a stale target", async () => {
    const context = createContext()
    registerSettingsRpcHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsGet,
      meta({
        target: {
          kind: "application-settings",
          id: "settings",
          epoch: "stale",
          generation: 1
        }
      })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("updates settings with a valid patch", async () => {
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsUpdate,
      mutationMeta(before.settings, { expectedRevision: before.revision }),
      { theme: "dark" }
    )

    expect(result).toMatchObject({
      ok: true,
      value: { value: expect.objectContaining({ theme: "dark" }) }
    })
  })

  it("forwards a combined theme and locale update without using the stale theme", async () => {
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsUpdate,
      mutationMeta(before.settings, { expectedRevision: before.revision }),
      { theme: "light", locale: "zh-cmn-Hans-CN" }
    )

    expect(result).toMatchObject({ ok: true })
    expect(context.audioHost.configurePluginEditorAppearance).toHaveBeenCalledWith({
      theme: "light",
      locale: "zh-cmn-Hans-CN"
    })
  })

  it("rejects invalid settings patches", async () => {
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsUpdate,
      mutationMeta(before.settings, {
        expectedRevision: before.revision,
        mutation: { operationId: "op-bad", idempotencyKey: "idem-bad" }
      }),
      { theme: "sepia" }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-unavailable" }
    })
  })

  it("sets software monitoring when idle", async () => {
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsSetSoftwareMonitoring,
      mutationMeta(before.settings, { expectedRevision: before.revision }),
      true
    )

    expect(result).toMatchObject({
      ok: true,
      value: { value: expect.objectContaining({ softwareMonitoringEnabled: true }) }
    })
    expect(context.projectGraph.setSoftwareMonitoringEnabled).toHaveBeenCalledWith(true)
  })

  it("rejects software monitoring when busy", async () => {
    const context = createContext((ctx) => {
      Object.defineProperty(ctx.recordings, "current", { get: () => ({ id: "rec" }) })
    })
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsSetSoftwareMonitoring,
      mutationMeta(before.settings, {
        expectedRevision: before.revision,
        mutation: { operationId: "op-mon", idempotencyKey: "idem-mon" }
      }),
      true
    )

    expect(result).toMatchObject({ ok: false, error: { code: "resource-unavailable" } })
  })

  it("configures audio host runtime preferences", async () => {
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)
    const preferences = {
      workerThreads: 2,
      maxBlockingThreads: 4
    }

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsConfigureAudioHostRuntime,
      mutationMeta(before.settings, {
        expectedRevision: before.revision,
        mutation: { operationId: "op-runtime", idempotencyKey: "idem-runtime" }
      }),
      preferences
    )

    expect(result).toMatchObject({ ok: true })
    expect(context.audioHost.configureRuntime).toHaveBeenCalledWith(preferences)
  })

  it("chooses a swap directory through the dialog", async () => {
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/new-swap"] })
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsChooseSwap,
      mutationMeta(before.settings, {
        expectedRevision: before.revision,
        mutation: { operationId: "op-swap", idempotencyKey: "idem-swap" }
      })
    )

    expect(result).toMatchObject({
      ok: true,
      value: { value: expect.objectContaining({ swapDirectory: "/new-swap" }) }
    })
  })

  it("keeps the current swap directory when the dialog is cancelled", async () => {
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsChooseSwap,
      mutationMeta(before.settings, {
        expectedRevision: before.revision,
        mutation: { operationId: "op-swap-cancel", idempotencyKey: "idem-swap-cancel" }
      })
    )

    expect(result).toMatchObject({
      ok: true,
      value: { value: expect.objectContaining({ swapDirectory: "/swap" }) }
    })
  })

  it("opens the swap directory in the shell", async () => {
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsOpenSwap,
      mutationMeta(before.settings, {
        expectedRevision: before.revision,
        mutation: { operationId: "op-open", idempotencyKey: "idem-open" }
      })
    )

    expect(electronMocks.shellOpenPath).toHaveBeenCalledWith("/swap")
    expect(result).toMatchObject({ ok: true })
  })

  it("maps shell open failures to unavailable", async () => {
    electronMocks.shellOpenPath.mockResolvedValue("Failed to open")
    const context = createContext()
    registerSettingsRpcHandlers(context)
    const before =
      context.lifecycle.applicationState.synchronizeApplicationSettings(defaultSettings)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.settingsOpenSwap,
      mutationMeta(before.settings, {
        expectedRevision: before.revision,
        mutation: { operationId: "op-open-fail", idempotencyKey: "idem-open-fail" }
      })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "resource-unavailable" } })
  })
})
