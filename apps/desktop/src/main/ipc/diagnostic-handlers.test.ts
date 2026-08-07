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
const benchmark = vi.hoisted(() => vi.fn(async () => ({ samples: [] })))

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
vi.mock("../audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audio")>()),
  createAudioBenchmarkReport: benchmark
}))
vi.mock("./audio-host-reconcile", () => ({ reconcileAudioHostEpoch: vi.fn(async () => false) }))

import { IPC_CHANNELS } from "@heron/contracts"
import { createContext, installWorkspace, invoke, meta, mutationMeta } from "./test-harness"
import { registerDiagnosticHandlers } from "./diagnostic-handlers"

describe("registerDiagnosticHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
    benchmark.mockReset().mockResolvedValue({ samples: [] })
  })

  it("serves lifecycle and system snapshots through the desktop resource", async () => {
    const context = createContext()
    registerDiagnosticHandlers(context)
    const desktop = context.lifecycle.applicationState.desktopSession

    await expect(
      invoke(electronMocks, IPC_CHANNELS.lifecycleSnapshot, meta({ target: desktop }))
    ).resolves.toMatchObject({ ok: true, value: { revision: 0 } })
    await expect(
      invoke(electronMocks, IPC_CHANNELS.systemPerformanceSnapshot, meta({ target: desktop }))
    ).resolves.toMatchObject({ ok: true, value: { capturedAt: 1 } })
    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.lifecycleSnapshot,
        meta({ target: { ...desktop, generation: 99 } })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("distinguishes closed, stale, and published compiled graph reads", async () => {
    const context = createContext()
    const compiled = vi.fn(async () => ({ graphRevision: 3 })) as never
    context.audioHost.compiledAudioGraphSnapshot = compiled
    registerDiagnosticHandlers(context)

    await expect(
      invoke(electronMocks, IPC_CHANNELS.compiledAudioGraphSnapshot, meta())
    ).resolves.toMatchObject({ ok: true, value: null })
    const workspace = installWorkspace(context.lifecycle)
    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.compiledAudioGraphSnapshot,
        meta({ target: { ...workspace.projectGraph, generation: 99 } })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "stale-resource" } })
    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.compiledAudioGraphSnapshot,
        meta({ target: workspace.projectGraph })
      )
    ).resolves.toMatchObject({ ok: true, value: { graphRevision: 3 } })
  })

  it("reports missing benchmark fixtures, success, and native failures", async () => {
    const context = createContext()
    const host = context.lifecycle.applicationState.audioHost
    registerDiagnosticHandlers(context)
    const request = (operationId: string) =>
      mutationMeta(host, {
        mutation: { operationId, idempotencyKey: operationId },
        expectedRevision: 0
      })

    vi.mocked(context.plugins.list).mockReturnValue({ plugins: [] } as never)
    await expect(
      invoke(electronMocks, IPC_CHANNELS.audioBenchmarkRun, request("missing"))
    ).resolves.toMatchObject({ ok: false, error: { details: { component: "main" } } })

    const effect = { source: { kind: "builtin", id: "live.minori.heron.gain" } }
    vi.mocked(context.plugins.list).mockReturnValue({ plugins: [effect] } as never)
    await expect(
      invoke(electronMocks, IPC_CHANNELS.audioBenchmarkRun, request("success"))
    ).resolves.toMatchObject({ ok: true, value: { samples: [] } })

    benchmark.mockRejectedValueOnce(new Error("native failure"))
    await expect(
      invoke(electronMocks, IPC_CHANNELS.audioBenchmarkRun, request("failure"))
    ).resolves.toMatchObject({ ok: false, error: { details: { component: "audio-host" } } })
  })
})
