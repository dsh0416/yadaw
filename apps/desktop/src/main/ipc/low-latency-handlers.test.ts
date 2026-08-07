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
import { createContext, invoke, meta, mutationMeta } from "./test-harness"
import { registerLowLatencyHandlers } from "./low-latency-handlers"

const runtime = {
  state: "running" as const,
  requestedBufferSize: 256,
  sampleRate: 48_000,
  inputSampleRate: 48_000,
  outputSampleRate: 48_000,
  inputBufferSize: 256,
  outputBufferSize: 256,
  ringBufferCapacityFrames: 1_024,
  ringBufferFillFrames: 0,
  inputLatencyMs: 1,
  outputLatencyMs: 1,
  ringBufferLatencyMs: 1,
  engineLatencyMs: 1,
  estimatedRoundTripLatencyMs: 3,
  xruns: 0,
  clockSync: "shared-device" as const,
  bufferFallback: false
}

const snapshot = {
  enabled: true,
  targetOutputChannelId: "master",
  pluginBudgetMs: 2,
  hasMonitoringPath: true,
  bypassedPluginInstanceIds: [],
  effectiveBudgetSamples: 96,
  unavoidableLatencySamples: 0
}

describe("registerLowLatencyHandlers", () => {
  beforeEach(() => electronMocks.handle.mockReset())

  it("reads a snapshot only through the current engine generation", async () => {
    const context = createContext()
    context.projectGraph.lowLatencySnapshot = vi.fn(async () => snapshot)
    const audio = await context.lifecycle.applicationState.commitAudioEngine(runtime)
    registerLowLatencyHandlers(context)

    await expect(
      invoke(electronMocks, IPC_CHANNELS.lowLatencyModeSnapshot, meta({ target: audio.engine! }))
    ).resolves.toMatchObject({ ok: true, value: snapshot, resourceRevision: audio.revision })
    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.lowLatencyModeSnapshot,
        meta({ target: { ...audio.engine!, generation: 99 } })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("validates the mutation envelope and bounded configuration", async () => {
    const context = createContext()
    const audio = await context.lifecycle.applicationState.commitAudioEngine(runtime)
    registerLowLatencyHandlers(context)

    for (const value of [
      null,
      [],
      { enabled: "yes" },
      { targetOutputChannelId: "" },
      { pluginBudgetMs: 51 }
    ]) {
      await expect(
        invoke(
          electronMocks,
          IPC_CHANNELS.lowLatencyModeConfigure,
          meta({ target: audio.engine! }),
          value
        )
      ).resolves.toMatchObject({ ok: false, error: { code: "validation-failed" } })
    }
  })

  it("rejects conflicts and active transport before committing", async () => {
    const context = createContext()
    context.projectGraph.configureLowLatencyMode = vi.fn(async () => snapshot)
    const audio = await context.lifecycle.applicationState.commitAudioEngine(runtime)
    registerLowLatencyHandlers(context)

    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.lowLatencyModeConfigure,
        mutationMeta(audio.engine!, { expectedRevision: audio.revision + 1 }),
        { enabled: true }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "revision-conflict" } })

    vi.mocked(context.transport.snapshot).mockResolvedValueOnce({
      state: "playing",
      positionFrames: 10,
      sampleRate: 48_000
    } as never)
    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.lowLatencyModeConfigure,
        mutationMeta(audio.engine!, {
          expectedRevision: audio.revision,
          mutation: { operationId: "playing", idempotencyKey: "playing" }
        }),
        { pluginBudgetMs: 4 }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("commits, rebinds duplicate results, and classifies thrown failures", async () => {
    const context = createContext()
    const configure = vi.fn().mockResolvedValueOnce(snapshot)
    context.projectGraph.configureLowLatencyMode = configure
    const audio = await context.lifecycle.applicationState.commitAudioEngine(runtime)
    registerLowLatencyHandlers(context)
    const request = mutationMeta(audio.engine!, {
      expectedRevision: audio.revision,
      mutation: { operationId: "configure", idempotencyKey: "configure" }
    })

    await expect(
      invoke(electronMocks, IPC_CHANNELS.lowLatencyModeConfigure, request, { enabled: true })
    ).resolves.toMatchObject({ ok: true, value: snapshot })
    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.lowLatencyModeConfigure,
        { ...request, requestId: "duplicate" },
        { enabled: true }
      )
    ).resolves.toMatchObject({ ok: true, requestId: "duplicate" })
    expect(configure).toHaveBeenCalledOnce()

    const contextWithFailure = createContext()
    contextWithFailure.projectGraph.configureLowLatencyMode = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("invalid"))
      .mockRejectedValueOnce(new Error("native failure"))
    const failedAudio =
      await contextWithFailure.lifecycle.applicationState.commitAudioEngine(runtime)
    electronMocks.handle.mockReset()
    registerLowLatencyHandlers(contextWithFailure)
    for (const [operationId, code] of [
      ["invalid", "validation-failed"],
      ["native", "operation-timeout-unknown"]
    ] as const) {
      await expect(
        invoke(
          electronMocks,
          IPC_CHANNELS.lowLatencyModeConfigure,
          mutationMeta(failedAudio.engine!, {
            expectedRevision: failedAudio.revision,
            mutation: { operationId, idempotencyKey: operationId }
          }),
          { enabled: true }
        )
      ).resolves.toMatchObject({ ok: false, error: { code } })
    }
  })
})
