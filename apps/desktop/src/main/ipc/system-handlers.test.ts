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
  getPath: vi.fn(() => "/tmp/heron-test")
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
  }
}))

import { IPC_CHANNELS } from "@heron/contracts"
import {
  createContext,
  invoke,
  meta,
  mutationMeta,
  registeredHandler,
  trustedEvent
} from "./test-harness"
import { registerSystemHandlers } from "./system-handlers"

const { engineInfo, processGain } = vi.hoisted(() => ({
  engineInfo: vi.fn(() => ({ name: "dsp", version: "1" })),
  processGain: vi.fn((samples: number[], gain: number) => samples.map((s) => s * gain))
}))

vi.mock("@heron/dsp-node", () => ({
  engineInfo,
  processGain
}))

describe("registerSystemHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
    engineInfo.mockClear()
    processGain.mockClear()
    electronMocks.fromWebContents.mockReset()
  })

  it("returns engine info for the offline worker target", async () => {
    const context = createContext()
    registerSystemHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.engineInfo,
      meta({ target: context.lifecycle.applicationState.offlineWorker })
    )

    expect(result).toMatchObject({ ok: true, value: { name: "dsp", version: "1" } })
  })

  it("rejects engine info for a stale target", async () => {
    const context = createContext()
    registerSystemHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.engineInfo,
      meta({
        target: { kind: "offline-worker", id: "offline-tools", epoch: "other", generation: 1 }
      })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("processes gain for the offline worker", async () => {
    const context = createContext()
    registerSystemHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.processGain,
      meta({ target: context.lifecycle.applicationState.offlineWorker }),
      { samples: [1, -1], gain: 2 }
    )

    expect(processGain).toHaveBeenCalledWith([1, -1], 2)
    expect(result).toMatchObject({ ok: true, value: [2, -2] })
  })

  it("rejects invalid gain requests", async () => {
    const context = createContext()
    registerSystemHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.processGain,
      meta({ target: context.lifecycle.applicationState.offlineWorker }),
      { samples: [1], gain: 100 }
    )

    expect(result).toMatchObject({ ok: false, error: { code: "invariant-violation" } })
  })

  it("dispatches window commands to the owning BrowserWindow", async () => {
    const window = {
      minimize: vi.fn(),
      isMaximized: vi.fn(() => false),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn(),
      isFullScreen: vi.fn(() => false),
      setFullScreen: vi.fn(),
      setTitleBarOverlay: vi.fn()
    }
    electronMocks.fromWebContents.mockReturnValue(window)
    const context = createContext()
    registerSystemHandlers(context)
    const event = trustedEvent()
    const requestMeta = mutationMeta(context.lifecycle.applicationState.desktopSession, {
      mutation: { operationId: "op-win", idempotencyKey: "idem-win" }
    })

    await registeredHandler(electronMocks, IPC_CHANNELS.applicationWindowCommand)(
      event,
      requestMeta,
      "window.minimize"
    )
    expect(window.minimize).toHaveBeenCalledOnce()

    await registeredHandler(electronMocks, IPC_CHANNELS.applicationWindowCommand)(
      event,
      {
        ...requestMeta,
        mutation: { operationId: "op-edit", idempotencyKey: "idem-edit" }
      },
      "edit.copy"
    )
    expect(event.sender.copy).toHaveBeenCalledOnce()
  })

  it("rejects unknown window commands", async () => {
    const context = createContext()
    registerSystemHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.applicationWindowCommand,
      mutationMeta(context.lifecycle.applicationState.desktopSession),
      "window.explode"
    )

    expect(result).toMatchObject({ ok: false, error: { code: "invariant-violation" } })
  })

  it("rejects invalid window themes", async () => {
    const context = createContext()
    registerSystemHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.applicationWindowTheme,
      mutationMeta(context.lifecycle.applicationState.desktopSession, {
        mutation: { operationId: "op-theme", idempotencyKey: "idem-theme" }
      }),
      "sepia"
    )

    expect(result).toMatchObject({ ok: false, error: { code: "invariant-violation" } })
  })

  it("applies a title-bar overlay theme on linux", async () => {
    const window = { setTitleBarOverlay: vi.fn() }
    electronMocks.fromWebContents.mockReturnValue(window)
    const context = createContext()
    registerSystemHandlers(context)
    const previous = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })

    try {
      const result = await registeredHandler(electronMocks, IPC_CHANNELS.applicationWindowTheme)(
        trustedEvent(),
        mutationMeta(context.lifecycle.applicationState.desktopSession, {
          mutation: { operationId: "op-theme-2", idempotencyKey: "idem-theme-2" }
        }),
        "dark"
      )
      expect(result).toMatchObject({ ok: true })
      expect(window.setTitleBarOverlay).toHaveBeenCalledWith(
        expect.objectContaining({ color: "#151515", height: 38 })
      )
    } finally {
      Object.defineProperty(process, "platform", { value: previous })
    }
  })
})
