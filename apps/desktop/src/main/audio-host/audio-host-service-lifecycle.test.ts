import { encode } from "@msgpack/msgpack"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AudioHostService, fakeHost, graph, resetFakeHost } from "./audio-host-service.fixture"

const automaticRuntime = {
  workerThreads: "auto" as const,
  maxBlockingThreads: "auto" as const,
  egressConcurrency: "auto" as const
}

function createService(failures: string[] = []): InstanceType<typeof AudioHostService> {
  return new AudioHostService(
    "audio-host",
    "crash-marker",
    automaticRuntime,
    undefined,
    (message) => failures.push(message),
    async () => {}
  )
}

describe("AudioHostService lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeHost()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("serializes heartbeats, restores the engine and gates transport during recovery", async () => {
    const failures: string[] = []
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      (message) => failures.push(message),
      async () => {}
    )
    service.start()
    const original = fakeHost.Client.instances[0]!
    const projectGraph = graph(44_100)
    await service.loadGraph(1, projectGraph.project, projectGraph.runtime)

    await service.startAudioEngine({
      backend: "asio",
      inputDeviceId: "input",
      outputDeviceId: "output",
      bufferSize: 128
    })
    await service.transport({ type: "play" })
    original.positionFrames = 4096

    await vi.advanceTimersByTimeAsync(1_000)
    expect(original.heartbeatCalls).toBe(1)

    original.heartbeatDeferred.reject(new Error("audio-host request: deadline exceeded"))
    await vi.waitFor(() => expect(fakeHost.Client.instances).toHaveLength(2))
    const replacement = fakeHost.Client.instances[1]!
    expect(original.closed).toBe(true)
    ;(
      service as unknown as {
        handleExit(client: InstanceType<typeof fakeHost.Client>, message: string): void
      }
    ).handleExit(original, "late rejection from retired client")
    expect(replacement.closed).toBe(false)
    expect(fakeHost.Client.instances).toHaveLength(2)

    const queuedTransport = service.transport({ type: "pause" })
    expect(
      replacement.commands.some(
        (command) =>
          command.type === "transport" &&
          (command.command as { kind?: string } | undefined)?.kind === "pause"
      )
    ).toBe(false)

    replacement.delayedEngineStart!.resolve({
      body: Buffer.from(
        encode({
          request_id: replacement.delayedEngineRequestId,
          result: {
            type: "audio-runtime",
            runtime: fakeHost.runtime("running", 44_100, 48_000)
          }
        })
      ),
      attachments: []
    })
    await queuedTransport

    const transportKinds = replacement.commands
      .filter((command) => command.type === "transport")
      .map((command) => (command.command as { kind: string }).kind)
    expect(transportKinds).toEqual(["set-loop", "seek", "play", "pause"])
    const restoredConfig = replacement.commands.find(
      (command) => command.type === "start-audio-engine"
    )?.config as { session_sample_rate?: number | null }
    expect(restoredConfig.session_sample_rate).toBe(44_100)
    expect(failures).toEqual(["heartbeat failed: audio-host request: deadline exceeded"])

    await service.stop()
  })

  it("rebuilds native-default streams at a new session rate and preserves playhead time", async () => {
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const client = fakeHost.Client.instances[0]!
    const initialGraph = graph(48_000)
    await service.loadGraph(1, initialGraph.project, initialGraph.runtime)
    await service.startAudioEngine({
      backend: "asio",
      inputDeviceId: "input",
      outputDeviceId: "output",
      bufferSize: 128
    })
    await service.transport({ type: "play" })
    client.positionFrames = 48_000

    const nextGraph = graph(44_100)
    await service.loadGraph(2, nextGraph.project, nextGraph.runtime)

    const starts = client.commands.filter((command) => command.type === "start-audio-engine")
    expect(
      starts.map(
        (command) => (command.config as { session_sample_rate?: number | null }).session_sample_rate
      )
    ).toEqual([48_000, 44_100])
    const transportCommands = client.commands
      .filter((command) => command.type === "transport")
      .map((command) => command.command as { kind: string; position_frames?: number })
    expect(transportCommands.slice(-4)).toEqual([
      { kind: "pause", position_frames: null },
      {
        kind: "set-loop",
        position_frames: null,
        loop_enabled: false,
        loop_start_tick: null,
        loop_end_tick: null
      },
      { kind: "seek", position_frames: 44_100 },
      { kind: "play", position_frames: null }
    ])
    expect(client.outputSampleRate).toBe(48_000)
    expect(client.sessionSampleRate).toBe(44_100)

    await service.stop()
  })

  it("uses the native output rate when no project graph is open", async () => {
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const runtime = await service.startAudioEngine({
      backend: "asio",
      inputDeviceId: "input",
      outputDeviceId: "output",
      bufferSize: 128
    })
    const client = fakeHost.Client.instances[0]!
    const config = client.commands.find((command) => command.type === "start-audio-engine")
      ?.config as { session_sample_rate?: number | null }

    expect(config.session_sample_rate).toBeNull()
    expect(runtime.sampleRate).toBe(48_000)
    expect(runtime.outputSampleRate).toBe(48_000)

    await service.stop()
  })

  it("commits a successful runtime configuration restart", async () => {
    const service = createService()
    service.start()
    const original = fakeHost.Client.instances[0]!

    await service.configureRuntime({
      workerThreads: 2,
      maxBlockingThreads: 3,
      egressConcurrency: 4
    })

    expect(original.closed).toBe(true)
    expect(fakeHost.Client.instances).toHaveLength(2)
    expect(fakeHost.Client.launchArguments.map((arguments_) => arguments_.slice(2, 5))).toEqual([
      [undefined, undefined, undefined],
      [2, 3, 4]
    ])
    expect(service.configurationRestarting).toBe(false)
    await service.stop()
  })

  it("rolls back to the previous runtime configuration when restart fails", async () => {
    const service = createService()
    service.start()
    fakeHost.Client.failNextLaunches = 1

    await expect(
      service.configureRuntime({
        workerThreads: 2,
        maxBlockingThreads: 3,
        egressConcurrency: 4
      })
    ).rejects.toThrow("Audio helper did not restart")

    expect(fakeHost.Client.instances).toHaveLength(2)
    expect(fakeHost.Client.launchArguments.map((arguments_) => arguments_.slice(2, 5))).toEqual([
      [undefined, undefined, undefined],
      [2, 3, 4],
      [undefined, undefined, undefined]
    ])
    expect(service.configurationRestarting).toBe(false)
    await service.stop()
  })

  it("reports when both runtime reconfiguration and rollback fail", async () => {
    const failures: string[] = []
    const service = createService(failures)
    service.start()
    fakeHost.Client.failNextLaunches = 2

    await expect(
      service.configureRuntime({
        workerThreads: 2,
        maxBlockingThreads: 3,
        egressConcurrency: 4
      })
    ).rejects.toThrow("Audio helper did not restart")

    expect(failures).toContainEqual(
      expect.stringContaining("audio runtime configuration and rollback failed")
    )
    expect(fakeHost.Client.instances).toHaveLength(1)
    expect(service.configurationRestarting).toBe(false)
    await service.stop()
  })

  it("does not exceed the helper restart budget", async () => {
    const service = createService()
    service.start()
    const original = fakeHost.Client.instances[0]!
    const exit = (
      service as unknown as {
        handleExit(client: InstanceType<typeof fakeHost.Client>, message: string): void
      }
    ).handleExit.bind(service)

    exit(original, "first helper failure")
    await vi.waitFor(() => expect(fakeHost.Client.instances).toHaveLength(2))
    await vi.waitFor(() => expect(service.configurationRestarting).toBe(false))
    exit(fakeHost.Client.instances[1]!, "second helper failure")
    await Promise.resolve()

    expect(fakeHost.Client.instances).toHaveLength(2)
    await service.stop()
  })

  it("allows repeated stop without closing the retired helper again", async () => {
    const service = createService()
    service.start()
    const client = fakeHost.Client.instances[0]!

    await service.stop()
    await service.stop()

    expect(client.closeCalls).toBe(1)
    expect(fakeHost.Client.instances).toHaveLength(1)
  })

  it("captures plug-in state before restoring MIDI, engine, graph, and transport", async () => {
    const service = createService()
    service.start()
    const order: string[] = []
    const internals = service as unknown as {
      audioTransport: { audioPreferences(): unknown }
      plugins: { loadedInstanceIds(): string[] }
      midiInput: { restore(client: InstanceType<typeof fakeHost.Client>): Promise<void> }
      lastGraph: { revision: number } | null
      capturePluginStatesForRestart(): Promise<void>
      shutdownCurrentClient(): Promise<void>
      restoreGraph(): Promise<void>
      waitForGraphPublication(revision: number): Promise<void>
    }
    vi.spyOn(service, "transportSnapshot").mockResolvedValue({
      state: "playing",
      positionFrames: 960,
      loopEnabled: true,
      loopRange: { startTick: 120, endTick: 480 }
    } as never)
    vi.spyOn(service, "audioEngineSnapshot").mockImplementation(async () => {
      order.push("audio-snapshot")
      return { state: "running" } as never
    })
    vi.spyOn(internals, "capturePluginStatesForRestart").mockImplementation(async () => {
      order.push("capture-plugin-state")
    })
    vi.spyOn(internals.plugins, "loadedInstanceIds").mockReturnValue([])
    vi.spyOn(service, "transport").mockImplementation(async (command) => {
      order.push(command.type)
      return {} as never
    })
    vi.spyOn(service, "stopAudioEngine").mockImplementation(async () => {
      order.push("stop-engine")
      return {} as never
    })
    const shutdown = vi.spyOn(internals, "shutdownCurrentClient").mockImplementation(async () => {
      order.push("shutdown-helper")
    })
    vi.spyOn(internals.audioTransport, "audioPreferences").mockReturnValue({})
    vi.spyOn(internals.midiInput, "restore").mockImplementation(async () => {
      order.push("restore-midi")
    })
    vi.spyOn(service, "startAudioEngine").mockImplementation(async () => {
      order.push("restore-engine")
      return {} as never
    })
    vi.spyOn(internals, "restoreGraph").mockImplementation(async () => {
      order.push("restore-graph")
    })
    internals.lastGraph = { revision: 4 }
    vi.spyOn(internals, "waitForGraphPublication").mockImplementation(async () => {
      order.push("publish-graph")
    })

    await service.configureRuntime({
      workerThreads: 2,
      maxBlockingThreads: 3,
      egressConcurrency: 4
    })

    expect(order).toEqual([
      "audio-snapshot",
      "capture-plugin-state",
      "pause",
      "stop-engine",
      "shutdown-helper",
      "audio-snapshot",
      "restore-midi",
      "restore-engine",
      "restore-graph",
      "publish-graph",
      "set-loop",
      "seek",
      "play"
    ])
    shutdown.mockRestore()
    await service.stop()
  })
})
