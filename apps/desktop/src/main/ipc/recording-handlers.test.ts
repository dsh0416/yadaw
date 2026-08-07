import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  getAllWindows: vi.fn(() => []),
  fromWebContents: vi.fn(),
  getPath: vi.fn(() => "/tmp/heron-test"),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  shellOpenPath: vi.fn(),
  quit: vi.fn(),
  showAboutPanel: vi.fn()
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
import { createContext, installWorkspace, invoke, meta, mutationMeta } from "./test-harness"
import { registerRecordingHandlers } from "./recording-handlers"

describe("registerRecordingHandlers", () => {
  beforeEach(() => electronMocks.handle.mockReset())

  it("validates and reads project audio and waveform assets", async () => {
    const context = createContext()
    const readAudio = vi.fn(async () => new Uint8Array([1, 2]))
    const readWaveform = vi.fn(async () => ({ buckets: [] }))
    context.projects.readAssetAudio = readAudio
    context.waveforms.readAsset = readWaveform as never
    registerRecordingHandlers(context)

    await expect(
      invoke(electronMocks, IPC_CHANNELS.assetAudioRead, meta(), "asset")
    ).resolves.toMatchObject({ ok: false, error: { code: "validation-failed" } })
    const workspace = installWorkspace(context.lifecycle)
    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.assetAudioRead,
        meta({ target: workspace.project }),
        "asset"
      )
    ).resolves.toMatchObject({ ok: true, value: new Uint8Array([1, 2]) })
    await expect(
      invoke(electronMocks, IPC_CHANNELS.assetWaveformRead, meta({ target: workspace.project }), {
        id: "asset",
        startFrame: 0,
        endFrame: 100,
        maxBuckets: 10
      })
    ).resolves.toMatchObject({ ok: true, value: { buckets: [] } })
    expect(readAudio).toHaveBeenCalledWith("asset")
    expect(readWaveform).toHaveBeenCalledOnce()

    await expect(
      invoke(electronMocks, IPC_CHANNELS.assetAudioRead, meta({ target: workspace.project }), "")
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant-violation" } })
  })

  it("maps running, cancel-requested, and terminal operation states", async () => {
    const context = createContext()
    const desktop = context.lifecycle.applicationState.desktopSession
    registerRecordingHandlers(context)
    context.operations.registry.begin({
      operationId: "running",
      idempotencyKey: "running",
      target: desktop,
      cancellable: true
    })

    await expect(
      invoke(electronMocks, IPC_CHANNELS.operationStatus, meta({ target: desktop }), "running")
    ).resolves.toMatchObject({ ok: true, value: { state: "running", cancellable: true } })
    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.operationCancel,
        mutationMeta(desktop, {
          mutation: { operationId: "cancel-call", idempotencyKey: "cancel-call" }
        }),
        "running"
      )
    ).resolves.toMatchObject({ ok: true, value: { state: "running" } })

    context.operations.registry.finish("running", "not-committed", {
      ok: true,
      requestId: "finish",
      value: null,
      warnings: []
    })
    await expect(
      invoke(electronMocks, IPC_CHANNELS.operationStatus, meta({ target: desktop }), "running")
    ).resolves.toMatchObject({ ok: true, value: { state: "terminal", outcome: "not-committed" } })
    await expect(
      invoke(electronMocks, IPC_CHANNELS.operationAcknowledge, mutationMeta(desktop), "running")
    ).resolves.toMatchObject({ ok: true, value: true })
    await expect(
      invoke(electronMocks, IPC_CHANNELS.operationStatus, meta({ target: desktop }), "missing")
    ).resolves.toMatchObject({ ok: true, value: null })
  })

  it("rejects non-string operation identifiers", async () => {
    const context = createContext()
    const desktop = context.lifecycle.applicationState.desktopSession
    registerRecordingHandlers(context)
    await expect(
      invoke(electronMocks, IPC_CHANNELS.operationStatus, meta({ target: desktop }), 4)
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant-violation" } })
    await expect(
      invoke(electronMocks, IPC_CHANNELS.operationCancel, mutationMeta(desktop), null)
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant-violation" } })
    await expect(
      invoke(electronMocks, IPC_CHANNELS.operationAcknowledge, mutationMeta(desktop), {})
    ).resolves.toMatchObject({ ok: false, error: { code: "invariant-violation" } })
  })
})
