import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AudioHostService, fakeHost, graph, resetFakeHost } from "./audio-host-service.fixture"

const automaticRuntime = {
  workerThreads: "auto" as const,
  maxBlockingThreads: "auto" as const
}

function createService(failures: string[] = []): InstanceType<typeof AudioHostService> {
  return new AudioHostService(
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

  it("reports a failed heartbeat without replacing the embedded runtime", async () => {
    const failures: string[] = []
    const service = new AudioHostService(
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
      },
      undefined,
      (message) => failures.push(message),
      async () => {}
    )
    service.start()
    const original = fakeHost.Client.instances[0]!
    await vi.advanceTimersByTimeAsync(1_000)
    expect(original.heartbeatCalls).toBe(1)

    original.heartbeatDeferred.reject(new Error("embedded runtime request timed out"))
    await vi.waitFor(() => expect(failures).toHaveLength(1))

    expect(original.closed).toBe(false)
    expect(fakeHost.Client.instances).toHaveLength(1)
    expect(failures).toEqual(["heartbeat failed: embedded runtime request timed out"])

    await service.stop()
  })

  it("rebuilds native-default streams at a new session rate and preserves playhead time", async () => {
    const service = new AudioHostService(
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
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
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
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

  it("stores runtime configuration for the next application launch", async () => {
    const service = createService()
    service.start()
    const original = fakeHost.Client.instances[0]!

    await service.configureRuntime({
      workerThreads: 2,
      maxBlockingThreads: 3
    })

    expect(original.closed).toBe(false)
    expect(fakeHost.Client.instances).toHaveLength(1)
    expect(service.configurationRestarting).toBe(false)
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
})
