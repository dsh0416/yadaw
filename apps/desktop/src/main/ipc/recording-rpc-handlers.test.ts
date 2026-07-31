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
import type { RecordingSession } from "@yadaw/contracts"
import {
  createContext,
  createWorkspace,
  installWorkspace,
  invoke,
  meta,
  mutationMeta
} from "./test-harness"
import { registerRecordingRpcHandlers } from "./recording-rpc-handlers"

const recordingSession: RecordingSession = {
  id: "recording-1",
  startedAt: 1,
  swapPath: "/swap/recording-1.partial.bwf",
  startFrame: 0,
  trackIds: ["audio-1"]
}

describe("registerRecordingRpcHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
  })

  it("rejects recordingStart without a mutation", async () => {
    const context = createContext()
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingStart,
      meta({ target: workspace.project }),
      {
        project: workspace.project,
        projectGraph: workspace.projectGraph,
        audioEngine: context.lifecycle.applicationState.audioHost
      }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "recording" } }
    })
  })

  it("rejects recordingStart when the request shape is invalid", async () => {
    const context = createContext()
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingStart,
      mutationMeta(workspace.project, { expectedRevision: workspace.revision }),
      { project: workspace.project }
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("rejects recordingStart on a revision conflict", async () => {
    const context = createContext()
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const audio = await context.lifecycle.applicationState.commitAudioEngine({
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

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingStart,
      mutationMeta(workspace.project, { expectedRevision: workspace.revision + 10 }),
      {
        project: workspace.project,
        projectGraph: workspace.projectGraph,
        audioEngine: audio.engine,
        countIn: false
      }
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "revision-conflict",
        details: { actualRevision: workspace.revision }
      }
    })
  })

  it("starts a recording and returns a committed resource snapshot", async () => {
    const context = createContext()
    vi.mocked(context.recordings.start).mockResolvedValue(recordingSession)
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const audio = await context.lifecycle.applicationState.commitAudioEngine({
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
    context.lifecycle.beginAudio("starting")
    context.lifecycle.completeAudio(audio.engine ? ({ state: "running" } as never) : ({} as never))

    // Reset audio lifecycle to running via setAudio for assert paths
    context.lifecycle.applicationState.setAudio({
      status: "running",
      runtime: {
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
      },
      error: null
    })

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingStart,
      mutationMeta(workspace.project, { expectedRevision: workspace.revision }),
      {
        project: workspace.project,
        projectGraph: workspace.projectGraph,
        audioEngine: audio.engine,
        countIn: false
      }
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        session: recordingSession,
        project: workspace.project,
        projectGraph: workspace.projectGraph
      }
    })
    expect(context.recordings.start).toHaveBeenCalledOnce()
    expect(context.recordings.start).toHaveBeenCalledWith(false)
  })

  it("returns unavailable when recordingStart throws before commit", async () => {
    const context = createContext()
    vi.mocked(context.recordings.start).mockRejectedValue(new Error("disk full"))
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const audio = await context.lifecycle.applicationState.commitAudioEngine({
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
    context.lifecycle.applicationState.setAudio({
      status: "running",
      runtime: {
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
      },
      error: null
    })

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingStart,
      mutationMeta(workspace.project, { expectedRevision: workspace.revision }),
      {
        project: workspace.project,
        projectGraph: workspace.projectGraph,
        audioEngine: audio.engine,
        countIn: true
      }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-unavailable" }
    })
    expect(context.recordings.start).toHaveBeenCalledWith(true)
    expect(context.recordings.abortStart).toHaveBeenCalled()
  })

  it("lists pending recordings for the active project", async () => {
    const pending = [{ id: "pending-1" }]
    const context = createContext()
    vi.mocked(context.recordings.listPending).mockResolvedValue(pending as never)
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingPendingList,
      meta({ target: workspace.project })
    )

    expect(result).toMatchObject({ ok: true, value: pending })
  })

  it("rejects pending list for a stale project target", async () => {
    const context = createContext()
    registerRecordingRpcHandlers(context)
    installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingPendingList,
      meta({ target: { kind: "project-session", id: "other", epoch: "x", generation: 1 } })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("rejects recover without a mutation or empty id", async () => {
    const context = createContext()
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.recordingRecover,
        meta({ target: workspace.project }),
        "pending-1"
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "validation-failed" } })

    await expect(
      invoke(
        electronMocks,
        IPC_CHANNELS.recordingRecover,
        mutationMeta(workspace.project, { expectedRevision: workspace.revision }),
        ""
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("recovers a pending recording", async () => {
    const context = createContext()
    const recovered = { id: "pending-1" }
    vi.mocked(context.recordings.recover).mockResolvedValue(recovered as never)
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingRecover,
      mutationMeta(workspace.project, { expectedRevision: workspace.revision }),
      "pending-1"
    )

    expect(result).toMatchObject({
      ok: true,
      value: { pending: recovered }
    })
  })

  it("maps recover failure before persistence to unavailable", async () => {
    const context = createContext()
    vi.mocked(context.recordings.recover).mockRejectedValue(new Error("missing sidecar"))
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingRecover,
      mutationMeta(workspace.project, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-recover", idempotencyKey: "idem-recover" }
      }),
      "pending-1"
    )

    expect(result).toMatchObject({ ok: false, error: { code: "resource-unavailable" } })
  })

  it("deletes a pending recording", async () => {
    const context = createContext()
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingDeletePending,
      mutationMeta(workspace.project, { expectedRevision: workspace.revision }),
      "pending-1"
    )

    expect(result).toMatchObject({ ok: true })
    expect(context.recordings.deletePending).toHaveBeenCalledWith("pending-1")
  })

  it("maps deletePending failure to unavailable", async () => {
    const context = createContext()
    vi.mocked(context.recordings.deletePending).mockRejectedValue(new Error("busy"))
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingDeletePending,
      mutationMeta(workspace.project, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-del", idempotencyKey: "idem-del" }
      }),
      "pending-1"
    )

    expect(result).toMatchObject({ ok: false, error: { code: "resource-unavailable" } })
  })

  it("rejects waveform snapshot for a missing recording resource", async () => {
    const context = createContext()
    registerRecordingRpcHandlers(context)
    installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingWaveformSnapshot,
      meta({
        target: { kind: "recording-session", id: "missing", epoch: "e", generation: 1 }
      }),
      { id: "asset-1", startFrame: 0, endFrame: 100, maxBuckets: 16 }
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("returns a waveform snapshot for the active recording", async () => {
    const context = createContext()
    const window = {
      id: "recording-1",
      startFrame: 0,
      endFrame: 100,
      peaks: new Float32Array([0, 1])
    }
    vi.mocked(context.recordings.waveformSnapshot).mockResolvedValue(window as never)
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const audio = await context.lifecycle.applicationState.commitAudioEngine({
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
    const resource = context.lifecycle.applicationState.commitRecording(recordingSession, {
      project: workspace.project,
      projectGraph: workspace.projectGraph,
      audioEngine: audio.engine!
    })

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingWaveformSnapshot,
      meta({ target: resource.recording }),
      { id: "recording-1", startFrame: 0, endFrame: 100, maxBuckets: 16 }
    )

    expect(result).toMatchObject({ ok: true, value: window })
  })

  it("rejects stop when no recording resource is active", async () => {
    const context = createContext()
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle, createWorkspace())

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingStop,
      mutationMeta(workspace.project, { expectedRevision: 1 })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("replays a finished recordingStart operation", async () => {
    const context = createContext()
    vi.mocked(context.recordings.start).mockResolvedValue(recordingSession)
    registerRecordingRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const audio = await context.lifecycle.applicationState.commitAudioEngine({
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
    context.lifecycle.applicationState.setAudio({
      status: "running",
      runtime: {
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
      },
      error: null
    })
    const requestMeta = mutationMeta(workspace.project, {
      expectedRevision: workspace.revision,
      requestId: "first",
      mutation: { operationId: "op-replay", idempotencyKey: "idem-replay" }
    })
    const request = {
      project: workspace.project,
      projectGraph: workspace.projectGraph,
      audioEngine: audio.engine,
      countIn: false
    }
    const first = await invoke(electronMocks, IPC_CHANNELS.recordingStart, requestMeta, request)
    expect(first).toMatchObject({ ok: true })

    const second = await invoke(
      electronMocks,
      IPC_CHANNELS.recordingStart,
      { ...requestMeta, requestId: "second" },
      request
    )
    expect(second).toMatchObject({ ok: true, requestId: "second" })
    expect(context.recordings.start).toHaveBeenCalledOnce()
  })
})
