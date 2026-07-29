import { decode, encode } from "@msgpack/msgpack"
import type { MixerGraphSnapshot } from "@yadaw/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fakeHost = vi.hoisted(() => {
  class Deferred<T> {
    readonly promise: Promise<T>
    resolve!: (value: T) => void
    reject!: (error: unknown) => void

    constructor() {
      this.promise = new Promise<T>((resolve, reject) => {
        this.resolve = resolve
        this.reject = reject
      })
    }
  }

  class Client {
    static instances: Client[] = []

    readonly commands: Array<Record<string, unknown>> = []
    readonly heartbeatDeferred = new Deferred<{ body: Buffer; attachments: Buffer[] }>()
    readonly delayedEngineStart =
      Client.instances.length === 1 ? new Deferred<{ body: Buffer; attachments: Buffer[] }>() : null
    delayedEngineRequestId = 0
    heartbeatCalls = 0
    closed = false
    failAudioBenchmark = false
    engineState: "running" | "stopped" = "stopped"
    sessionSampleRate = 48_000
    outputSampleRate = 48_000
    graphRevision = 0
    transportState = 0
    positionFrames = 0
    latencyMeasurement = {
      status: "idle",
      input_channel: null as number | null,
      output_channel: null as number | null,
      measured_round_trip_latency_ms: null as number | null,
      failure: null as string | null
    }

    constructor(..._arguments: unknown[]) {
      Client.instances.push(this)
    }

    request(payload: Buffer): Promise<{ body: Buffer; attachments: Buffer[] }> {
      const request = decode(payload) as {
        request_id: number
        command: Record<string, unknown> & {
          command?: { kind?: string; position_frames?: number | null }
        }
      }
      this.commands.push(request.command)
      const response = (result: Record<string, unknown>) =>
        Promise.resolve({
          body: Buffer.from(encode({ request_id: request.request_id, result })),
          attachments: []
        })

      if (request.command.type === "audio-engine-snapshot") {
        return response({
          type: "audio-runtime",
          runtime: runtime(this.engineState, this.sessionSampleRate, this.outputSampleRate)
        })
      }
      if (request.command.type === "start-audio-engine") {
        const config = request.command.config as { session_sample_rate?: number | null }
        this.engineState = "running"
        this.sessionSampleRate = config.session_sample_rate ?? this.outputSampleRate
        if (this.delayedEngineStart) {
          this.delayedEngineRequestId = request.request_id
          return this.delayedEngineStart.promise
        }
        return response({
          type: "audio-runtime",
          runtime: runtime("running", this.sessionSampleRate, this.outputSampleRate)
        })
      }
      if (request.command.type === "start-round-trip-latency-measurement") {
        const value = request.command.request as {
          input_channel: number
          output_channel: number
        }
        this.latencyMeasurement = {
          status: "preparing",
          input_channel: value.input_channel,
          output_channel: value.output_channel,
          measured_round_trip_latency_ms: null,
          failure: null
        }
        return response({
          type: "round-trip-latency-measurement",
          measurement: this.latencyMeasurement
        })
      }
      if (request.command.type === "round-trip-latency-measurement-snapshot") {
        return response({
          type: "round-trip-latency-measurement",
          measurement: this.latencyMeasurement
        })
      }
      if (request.command.type === "update-graph") {
        const update = request.command.update as { revision?: number }
        this.graphRevision = update.revision ?? 0
        return response({ type: "graph-accepted", revision: this.graphRevision })
      }
      if (request.command.type === "transport") {
        const kind = request.command.command?.kind
        if (kind === "seek") {
          this.positionFrames = request.command.command?.position_frames ?? 0
          this.transportState = 0
        } else if (kind === "play") {
          this.transportState = 1
        } else {
          this.transportState = 0
        }
        return response({
          type: "transport-snapshot",
          transport: {
            state: this.transportState === 1 ? "playing" : "stopped",
            position_frames: this.positionFrames,
            sample_rate: this.sessionSampleRate
          }
        })
      }
      if (request.command.type === "load-plugin") {
        return response({
          type: "plugin-loaded",
          runtime_handle: 1,
          latency_samples: 0,
          tail_samples: 0
        })
      }
      if (request.command.type === "run-audio-benchmark") {
        if (this.failAudioBenchmark) {
          return response({ type: "error", message: "benchmark failed" })
        }
        return response({
          type: "audio-benchmark",
          report: {
            duration_ms: 1,
            overall_realtime_factor: 2,
            worst_p99_deadline_utilization_percent: 10,
            scenarios: []
          }
        })
      }
      return response({ type: "accepted" })
    }

    heartbeatRequest(payload: Buffer): Promise<{ body: Buffer; attachments: Buffer[] }> {
      const request = decode(payload) as {
        request_id: number
        command: { type?: string }
      }
      if (request.command.type === "shutdown") {
        return Promise.resolve({
          body: Buffer.from(
            encode({ request_id: request.request_id, result: { type: "accepted" } })
          ),
          attachments: []
        })
      }
      this.heartbeatCalls += 1
      return this.heartbeatDeferred.promise
    }

    readTelemetry(): Buffer {
      return Buffer.from(
        encode([
          1,
          this.graphRevision,
          0,
          this.transportState,
          this.positionFrames,
          this.sessionSampleRate,
          []
        ])
      )
    }

    enqueueParameter(): string {
      return "accepted"
    }

    transportDiagnostics(): Buffer {
      return Buffer.from(encode([]))
    }

    drainEvents(): Buffer[] {
      return []
    }

    close(): void {
      this.closed = true
    }
  }

  const runtime = (
    state: "running" | "stopped",
    sampleRate = 48_000,
    outputSampleRate = 48_000
  ) => ({
    state,
    requested_buffer_size: 128,
    sample_rate: sampleRate,
    input_sample_rate: 48_000,
    output_sample_rate: outputSampleRate,
    input_buffer_size: 128,
    output_buffer_size: 128,
    ring_buffer_capacity_frames: 512,
    ring_buffer_fill_frames: 256,
    input_latency_ms: 1,
    output_latency_ms: 1,
    ring_buffer_latency_ms: 1,
    engine_latency_ms: 1,
    estimated_round_trip_latency_ms: 4,
    xruns: 0,
    clock_sync: "shared",
    buffer_fallback: false
  })

  return { Client, runtime }
})

vi.mock("@yadaw/audio-host-client", () => ({
  AudioHostIpcClient: class extends fakeHost.Client {
    heartbeat(payload: Buffer): Promise<{ body: Buffer; attachments: Buffer[] }> {
      return this.heartbeatRequest(payload)
    }
  }
}))

import { AudioHostService } from "./audio-host-service"
import type { AudioHostGraph } from "./audio-host-service"
import type { PluginDescriptor } from "@yadaw/contracts"

function graph(sampleRate: number): {
  project: MixerGraphSnapshot
  runtime: AudioHostGraph
} {
  return {
    project: {
      sampleRate,
      plugins: []
    } as unknown as MixerGraphSnapshot,
    runtime: {
      sample_rate: sampleRate,
      channels: [],
      sends: [],
      clips: [],
      plugins: [],
      midi_clips: [],
      tempo_events: [],
      time_signature_events: []
    }
  }
}

describe("AudioHostService recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fakeHost.Client.instances.length = 0
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
    expect(transportKinds).toEqual(["seek", "play", "pause"])
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
    expect(transportCommands.slice(-3)).toEqual([
      { kind: "pause", position_frames: null },
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

  it("unloads audio benchmark VST3 instances after success and failure", async () => {
    const effect = {
      kind: "effect",
      compatibility: "compatible",
      supportedAudioModes: ["stereo"],
      classId: "test-gain",
      modulePath: "/tmp/gain.vst3"
    } as PluginDescriptor

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

    await service.runAudioBenchmark(effect)
    const commandTypes = client.commands.map((command) => command.type)
    const firstBenchmark = commandTypes.indexOf("run-audio-benchmark")
    expect(commandTypes.slice(0, firstBenchmark)).toEqual(Array(64).fill("load-plugin"))
    expect(commandTypes.slice(firstBenchmark, firstBenchmark + 1)).toEqual(["run-audio-benchmark"])
    expect(commandTypes.slice(firstBenchmark + 1)).toEqual(Array(64).fill("unload-plugin"))
    const unloadIds = client.commands
      .filter((command) => command.type === "unload-plugin")
      .map((command) => command.instance_id)
    expect(unloadIds[0]).toBe("__yadaw-audio-benchmark-gain-0")
    expect(unloadIds[63]).toBe("__yadaw-audio-benchmark-gain-63")
    expect(
      (
        service as unknown as { plugins: { loadedInstanceIds(): string[] } }
      ).plugins.loadedInstanceIds()
    ).toEqual([])

    client.commands.length = 0
    client.failAudioBenchmark = true
    await expect(service.runAudioBenchmark(effect)).rejects.toThrow("benchmark failed")
    expect(client.commands.filter((command) => command.type === "unload-plugin")).toHaveLength(64)
    expect(
      (
        service as unknown as { plugins: { loadedInstanceIds(): string[] } }
      ).plugins.loadedInstanceIds()
    ).toEqual([])

    await service.stop()
  })

  it("round-trips physical latency channel selections and measurement results", async () => {
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

    const started = await service.startRoundTripLatencyMeasurement({
      inputChannel: 2,
      outputChannel: 4
    })
    expect(started).toMatchObject({
      status: "preparing",
      inputChannel: 2,
      outputChannel: 4
    })
    expect(client.commands.at(-1)).toEqual({
      type: "start-round-trip-latency-measurement",
      request: { input_channel: 2, output_channel: 4 }
    })

    client.latencyMeasurement = {
      status: "complete",
      input_channel: 2,
      output_channel: 4,
      measured_round_trip_latency_ms: 8.75,
      failure: null
    }
    await expect(service.roundTripLatencyMeasurementSnapshot()).resolves.toEqual({
      status: "complete",
      inputChannel: 2,
      outputChannel: 4,
      measuredRoundTripLatencyMs: 8.75,
      failure: null
    })

    await service.stop()
  })
})
