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

import { IPC_CHANNELS, INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import { createContext, installWorkspace, invoke, meta, mutationMeta } from "./test-harness"
import { registerAudioHandlers } from "./audio-handlers"

const runningRuntime = {
  ...INITIAL_AUDIO_RUNTIME_SNAPSHOT,
  state: "running" as const,
  sampleRate: 48_000,
  inputSampleRate: 48_000,
  outputSampleRate: 48_000,
  requestedBufferSize: 256,
  inputBufferSize: 256,
  outputBufferSize: 256,
  clockSync: "locked" as const
}

const preferences = {
  backend: "mock" as const,
  inputDeviceId: "in-1",
  outputDeviceId: "out-1",
  bufferSize: 256
}

describe("registerAudioHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
  })

  it("lists audio backends for the audio host", async () => {
    const context = createContext()
    registerAudioHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioBackends,
      meta({ target: context.lifecycle.applicationState.audioHost })
    )

    expect(result).toMatchObject({ ok: true, value: ["mock"] })
  })

  it("lists devices for a validated backend", async () => {
    const devices = {
      inputs: [{ id: "in-1", name: "In" }],
      outputs: [{ id: "out-1", name: "Out" }]
    }
    const context = createContext()
    vi.mocked(context.audioHost.listAudioDevices).mockResolvedValue(devices as never)
    registerAudioHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioDevices,
      meta({ target: context.lifecycle.applicationState.audioHost }),
      "mock"
    )

    expect(result).toMatchObject({ ok: true, value: devices })
  })

  it("rejects unknown backends", async () => {
    const context = createContext()
    registerAudioHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioDevices,
      meta({ target: context.lifecycle.applicationState.audioHost }),
      "jack"
    )

    expect(result).toMatchObject({ ok: false, error: { code: "invariant-violation" } })
  })

  it("rejects audioStart without a mutation", async () => {
    const context = createContext()
    registerAudioHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioStart,
      meta({ target: context.lifecycle.applicationState.audioHost }),
      preferences
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("starts the audio engine and commits resources", async () => {
    const context = createContext()
    vi.mocked(context.audioHost.startAudioEngine).mockResolvedValue(runningRuntime)
    registerAudioHandlers(context)
    installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioStart,
      mutationMeta(context.lifecycle.applicationState.audioHost),
      preferences
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        engine: expect.objectContaining({ kind: "audio-engine" }),
        transport: expect.objectContaining({ kind: "transport" }),
        runtime: expect.objectContaining({ state: "running" })
      }
    })
  })

  it("returns unavailable when audioStart fails", async () => {
    const context = createContext()
    vi.mocked(context.audioHost.startAudioEngine).mockRejectedValue(new Error("device busy"))
    vi.mocked(context.audioHost.audioEngineSnapshot).mockResolvedValue(
      INITIAL_AUDIO_RUNTIME_SNAPSHOT
    )
    registerAudioHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioStart,
      mutationMeta(context.lifecycle.applicationState.audioHost, {
        mutation: { operationId: "op-start-fail", idempotencyKey: "idem-start-fail" }
      }),
      preferences
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-unavailable", details: { component: "audio-host" } }
    })
  })

  it("stops the audio engine", async () => {
    const context = createContext()
    vi.mocked(context.audioHost.startAudioEngine).mockResolvedValue(runningRuntime)
    vi.mocked(context.audioHost.stopAudioEngine).mockResolvedValue(INITIAL_AUDIO_RUNTIME_SNAPSHOT)
    registerAudioHandlers(context)
    await invoke(
      electronMocks,
      IPC_CHANNELS.audioStart,
      mutationMeta(context.lifecycle.applicationState.audioHost, {
        mutation: { operationId: "op-start", idempotencyKey: "idem-start" }
      }),
      preferences
    )
    const engine = context.lifecycle.applicationState.audioResourceSnapshot().engine!

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioStop,
      mutationMeta(engine, {
        mutation: { operationId: "op-stop", idempotencyKey: "idem-stop" }
      })
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        engine: null,
        transport: null,
        runtime: expect.objectContaining({ state: "stopped" })
      }
    })
  })

  it("rejects stop for a stale engine target", async () => {
    const context = createContext()
    registerAudioHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioStop,
      mutationMeta({
        kind: "audio-engine",
        id: "audio-engine",
        epoch: "stale",
        generation: 1
      })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("returns an audio snapshot for the active engine", async () => {
    const context = createContext()
    vi.mocked(context.audioHost.startAudioEngine).mockResolvedValue(runningRuntime)
    vi.mocked(context.audioHost.audioEngineSnapshot).mockResolvedValue(runningRuntime)
    registerAudioHandlers(context)
    await invoke(
      electronMocks,
      IPC_CHANNELS.audioStart,
      mutationMeta(context.lifecycle.applicationState.audioHost, {
        mutation: { operationId: "op-start-2", idempotencyKey: "idem-start-2" }
      }),
      preferences
    )
    const engine = context.lifecycle.applicationState.audioResourceSnapshot().engine!

    const result = await invoke(electronMocks, IPC_CHANNELS.audioSnapshot, meta({ target: engine }))

    expect(result).toMatchObject({ ok: true, value: expect.objectContaining({ state: "running" }) })
  })

  it("starts round-trip latency measurement", async () => {
    const context = createContext()
    vi.mocked(context.audioHost.startRoundTripLatencyMeasurement).mockResolvedValue({
      started: true
    } as never)
    registerAudioHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioRoundTripLatencyStart,
      mutationMeta(context.lifecycle.applicationState.audioHost, {
        mutation: { operationId: "op-rtl", idempotencyKey: "idem-rtl" }
      }),
      { inputChannel: 1, outputChannel: 2 }
    )

    expect(result).toMatchObject({ ok: true, value: { started: true } })
  })

  it("reads the round-trip latency snapshot", async () => {
    const context = createContext()
    vi.mocked(context.audioHost.roundTripLatencyMeasurementSnapshot).mockResolvedValue({
      state: "idle"
    } as never)
    registerAudioHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.audioRoundTripLatencySnapshot,
      meta({ target: context.lifecycle.applicationState.audioHost })
    )

    expect(result).toMatchObject({ ok: true, value: { state: "idle" } })
  })

  it("replays a finished audioStart operation", async () => {
    const context = createContext()
    vi.mocked(context.audioHost.startAudioEngine).mockResolvedValue(runningRuntime)
    registerAudioHandlers(context)
    const requestMeta = mutationMeta(context.lifecycle.applicationState.audioHost, {
      mutation: { operationId: "op-replay", idempotencyKey: "idem-replay" }
    })

    const first = await invoke(electronMocks, IPC_CHANNELS.audioStart, requestMeta, preferences)
    const second = await invoke(
      electronMocks,
      IPC_CHANNELS.audioStart,
      { ...requestMeta, requestId: "request-2" },
      preferences
    )

    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true, requestId: "request-2" })
    expect(context.audioHost.startAudioEngine).toHaveBeenCalledOnce()
  })
})
