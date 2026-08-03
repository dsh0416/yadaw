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
import { createContext, installWorkspace, invoke, meta, mutationMeta } from "./test-harness"
import { registerTransportHandlers } from "./transport-handlers"

async function runningAudio(context: ReturnType<typeof createContext>) {
  return context.lifecycle.applicationState.commitAudioEngine({
    state: "running",
    requestedBufferSize: 256,
    sampleRate: 48_000,
    inputSampleRate: 48_000,
    outputSampleRate: 48_000,
    inputBufferSize: 256,
    outputBufferSize: 256,
    ringBufferCapacityFrames: 1024,
    ringBufferFillFrames: 0,
    inputLatencyMs: 1,
    outputLatencyMs: 1,
    ringBufferLatencyMs: 1,
    engineLatencyMs: 1,
    estimatedRoundTripLatencyMs: 3,
    xruns: 0,
    clockSync: "shared-device",
    bufferFallback: false
  })
}

describe("registerTransportHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
  })

  it("rejects transport commands without mutation or type", async () => {
    const context = createContext()
    registerTransportHandlers(context)
    installWorkspace(context.lifecycle)
    const audio = await runningAudio(context)

    await expect(
      invoke(electronMocks, IPC_CHANNELS.transportCommand, meta({ target: audio.transport! }), {
        type: "stop"
      })
    ).resolves.toMatchObject({ ok: false, error: { code: "validation-failed" } })

    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.transportCommand,
        mutationMeta(audio.transport!, { expectedRevision: audio.revision }),
        null
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("rejects stale transport targets", async () => {
    const context = createContext()
    registerTransportHandlers(context)
    await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.transportCommand,
      mutationMeta(
        { kind: "transport", id: "transport", epoch: "stale", generation: 1 },
        { expectedRevision: 0 }
      ),
      { type: "stop" }
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("rejects revision conflicts", async () => {
    const context = createContext()
    registerTransportHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.transportCommand,
      mutationMeta(audio.transport!, { expectedRevision: audio.revision + 5 }),
      { type: "stop" }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "revision-conflict", details: { actualRevision: audio.revision } }
    })
  })

  it("executes a transport command and advances revision", async () => {
    const context = createContext()
    const snapshot = {
      state: "playing" as const,
      positionFrames: 100,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }
    vi.mocked(context.transport.command).mockResolvedValue(snapshot)
    registerTransportHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.transportCommand,
      mutationMeta(audio.transport!, { expectedRevision: audio.revision }),
      { type: "play" }
    )

    expect(result).toMatchObject({
      ok: true,
      value: snapshot,
      resourceRevision: audio.revision + 1
    })
  })

  it("rejects an invalid loop range before dispatch", async () => {
    const context = createContext()
    registerTransportHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.transportCommand,
      mutationMeta(audio.transport!, { expectedRevision: audio.revision }),
      { type: "set-loop", enabled: true, range: { startTick: 960, endTick: 960 } }
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
    expect(context.transport.command).not.toHaveBeenCalled()
  })

  it("returns unknown outcome when transport.command throws", async () => {
    const context = createContext()
    vi.mocked(context.transport.command).mockRejectedValue(new Error("host down"))
    registerTransportHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.transportCommand,
      mutationMeta(audio.transport!, {
        expectedRevision: audio.revision,
        mutation: { operationId: "op-fail", idempotencyKey: "idem-fail" }
      }),
      { type: "play" }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-timeout-unknown", outcome: "unknown" }
    })
  })

  it("returns a transport snapshot", async () => {
    const context = createContext()
    const snapshot = {
      state: "stopped" as const,
      positionFrames: 0,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }
    vi.mocked(context.transport.snapshot).mockResolvedValue(snapshot)
    registerTransportHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.transportSnapshot,
      meta({ target: audio.transport! })
    )

    expect(result).toMatchObject({ ok: true, value: snapshot })
  })

  it("returns a stopped snapshot while shutting down", async () => {
    const context = createContext((ctx) => {
      vi.mocked(ctx.isShuttingDown).mockReturnValue(true)
    })
    registerTransportHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.transportSnapshot,
      meta({ target: audio.transport! })
    )

    expect(result).toMatchObject({
      ok: true,
      value: { state: "stopped", positionFrames: 0 }
    })
    expect(context.transport.snapshot).not.toHaveBeenCalled()
  })

  it("replays a completed transport operation", async () => {
    const context = createContext()
    const snapshot = {
      state: "playing" as const,
      positionFrames: 10,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }
    vi.mocked(context.transport.command).mockResolvedValue(snapshot)
    registerTransportHandlers(context)
    const audio = await runningAudio(context)
    const requestMeta = mutationMeta(audio.transport!, {
      expectedRevision: audio.revision,
      mutation: { operationId: "op-replay", idempotencyKey: "idem-replay" }
    })

    await invoke(electronMocks, IPC_CHANNELS.transportCommand, requestMeta, { type: "play" })
    const replayed = await invoke(
      electronMocks,
      IPC_CHANNELS.transportCommand,
      { ...requestMeta, requestId: "request-2" },
      { type: "play" }
    )

    expect(replayed).toMatchObject({ ok: true, requestId: "request-2", value: snapshot })
    expect(context.transport.command).toHaveBeenCalledOnce()
  })
})
