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
  getPath: vi.fn(() => "/tmp/yadaw-test")
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

import { IPC_CHANNELS } from "@yadaw/contracts"
import {
  createContext,
  emptyGraph,
  installWorkspace,
  invoke,
  meta,
  mutationMeta
} from "./test-harness"
import { registerMixerHandlers } from "./mixer-handlers"

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

describe("registerMixerHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
  })

  it("loads the project graph for a matching target", async () => {
    const context = createContext()
    vi.mocked(context.projectGraph.snapshot).mockResolvedValue(emptyGraph)
    registerMixerHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectGraphLoad,
      meta({ target: workspace.projectGraph })
    )

    expect(result).toMatchObject({
      ok: true,
      value: emptyGraph,
      resourceRevision: workspace.revision
    })
  })

  it("rejects graph load with a mutation meta", async () => {
    const context = createContext()
    registerMixerHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectGraphLoad,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision })
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "mutation" } }
    })
  })

  it("rejects stale graph targets", async () => {
    const context = createContext()
    registerMixerHandlers(context)
    installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectGraphLoad,
      meta({
        target: { kind: "project-graph", id: "project:graph", epoch: "stale", generation: 1 }
      })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("reloads the graph and advances the workspace revision", async () => {
    const context = createContext()
    vi.mocked(context.projectGraph.load).mockResolvedValue(emptyGraph)
    registerMixerHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectGraphReload,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      undefined
    )

    expect(result).toMatchObject({ ok: true, value: emptyGraph })
    expect(context.lifecycle.applicationState.workspaceSnapshot()?.revision).toBeGreaterThan(
      workspace.revision
    )
  })

  it("rejects graph reload on revision conflict", async () => {
    const context = createContext()
    registerMixerHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectGraphReload,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision + 3 })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "revision-conflict" } })
  })

  it("rejects malformed project commands", async () => {
    const context = createContext()
    registerMixerHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectCommandExecute,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      { notType: true }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "command" } }
    })
  })

  it("delegates valid project commands", async () => {
    const context = createContext()
    const commandResult = {
      ok: true as const,
      requestId: "request-1",
      value: { graph: emptyGraph },
      warnings: []
    }
    vi.mocked(context.projectCommands.execute).mockResolvedValue(commandResult as never)
    registerMixerHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const command = { type: "update-channel", channelId: "master", patch: { gainDb: -3 } }
    const requestMeta = mutationMeta(workspace.projectGraph, {
      expectedRevision: workspace.revision
    })

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectCommandExecute,
      requestMeta,
      command
    )

    expect(context.projectCommands.execute).toHaveBeenCalledWith(requestMeta, command)
    expect(result).toEqual(commandResult)
  })

  it("previews mixer parameters", async () => {
    const context = createContext()
    registerMixerHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.mixerPreview,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      { channelId: "master", gainDb: -6 }
    )

    expect(result).toMatchObject({ ok: true })
    expect(context.mixerRuntime.preview).toHaveBeenCalled()
  })

  it("returns mixer snapshots for the audio engine", async () => {
    const context = createContext()
    const snapshot = { meters: [{ id: "master", peak: 0.1 }], capturedAt: 42 }
    vi.mocked(context.mixerRuntime.runtimeSnapshot).mockResolvedValue(snapshot as never)
    registerMixerHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.mixerSnapshot,
      meta({ target: audio.engine! })
    )

    expect(result).toMatchObject({ ok: true, value: snapshot })
  })

  it("returns an empty mixer snapshot while shutting down", async () => {
    const context = createContext((ctx) => {
      vi.mocked(ctx.isShuttingDown).mockReturnValue(true)
    })
    registerMixerHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.mixerSnapshot,
      meta({ target: audio.engine! })
    )

    expect(result).toMatchObject({ ok: true, value: { meters: [] } })
  })

  it("clears meter clips", async () => {
    const context = createContext()
    registerMixerHandlers(context)
    const audio = await runningAudio(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.mixerClearMeterClips,
      mutationMeta(audio.engine!, { expectedRevision: audio.revision })
    )

    expect(result).toMatchObject({ ok: true })
    expect(context.mixerRuntime.clearMeterClips).toHaveBeenCalledOnce()
  })

  it("rejects mixer snapshot without an engine", async () => {
    const context = createContext()
    registerMixerHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.mixerSnapshot,
      meta({
        target: { kind: "audio-engine", id: "audio-engine", epoch: "e", generation: 1 }
      })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })
})
