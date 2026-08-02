import { decode, encode } from "@msgpack/msgpack"
import { IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import type { PluginInstanceState, ProjectGraphSnapshot } from "@yadaw/contracts"
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
    static failNextAudioBenchmark = false
    static failNextIpcBenchmark = false
    static deferNextAudioBenchmark = false

    readonly commands: Array<Record<string, unknown>> = []
    readonly heartbeatDeferred = new Deferred<{ body: Buffer; attachments: Buffer[] }>()
    readonly delayedEngineStart =
      Client.instances.length === 1 ? new Deferred<{ body: Buffer; attachments: Buffer[] }>() : null
    delayedEngineRequestId = 0
    heartbeatCalls = 0
    closed = false
    failAudioBenchmark = false
    failIpcBenchmark = false
    audioBenchmarkDeferred: Deferred<void> | null = null
    engineState: "running" | "stopped" = "stopped"
    sessionSampleRate = 48_000
    outputSampleRate = 48_000
    graphRevision = 0
    graphCandidate: {
      operationId: string
      projectGraph: Record<string, unknown>
      baseRevision: number
      graphRevision: number
    } | null = null
    lastGraphOperation: {
      operationId: string
      outcome: "committed" | "not-committed"
      graphRevision: number
    } | null = null
    transportState = 0
    positionFrames = 0
    loopEnabled = false
    loopStartTick: number | null = null
    loopEndTick: number | null = null
    latencyMeasurement = {
      status: "idle",
      input_channel: null as number | null,
      output_channel: null as number | null,
      measured_round_trip_latency_ms: null as number | null,
      failure: null as string | null
    }

    constructor(..._arguments: unknown[]) {
      this.failAudioBenchmark = Client.failNextAudioBenchmark
      Client.failNextAudioBenchmark = false
      this.failIpcBenchmark = Client.failNextIpcBenchmark
      Client.failNextIpcBenchmark = false
      if (Client.deferNextAudioBenchmark) {
        this.audioBenchmarkDeferred = new Deferred<void>()
        Client.deferNextAudioBenchmark = false
      }
      Client.instances.push(this)
    }

    request(
      payload: Buffer,
      attachments: Buffer[] = []
    ): Promise<{ body: Buffer; attachments: Buffer[] }> {
      const request = decode(payload) as {
        request_id: number
        command: Record<string, unknown> & {
          command?: {
            kind?: string
            position_frames?: number | null
            loop_enabled?: boolean
            loop_start_tick?: number | null
            loop_end_tick?: number | null
          }
        }
      }
      this.commands.push(request.command)
      const response = (result: Record<string, unknown>, responseAttachments: Buffer[] = []) =>
        Promise.resolve({
          body: Buffer.from(encode({ request_id: request.request_id, result })),
          attachments: responseAttachments
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
      if (request.command.type === "stop-audio-engine") {
        this.engineState = "stopped"
        return response({
          type: "audio-runtime",
          runtime: runtime("stopped", this.sessionSampleRate, this.outputSampleRate)
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
      if (
        request.command.type === "graph-deployment-snapshot" ||
        request.command.type === "prepare-graph" ||
        request.command.type === "activate-graph" ||
        request.command.type === "abort-graph"
      ) {
        const meta = request.command.meta as {
          requestId: string
          mutation?: { operationId: string }
        }
        const transaction = request.command.request as
          | {
              projectGraph: Record<string, unknown>
              baseRevision: number
              graphRevision?: number
            }
          | undefined
        let value: Record<string, unknown>
        if (request.command.type === "prepare-graph" && transaction) {
          this.graphCandidate = {
            operationId: meta.mutation?.operationId ?? "",
            projectGraph: transaction.projectGraph,
            baseRevision: transaction.baseRevision,
            graphRevision: transaction.graphRevision ?? 0
          }
          value = { type: "prepared", snapshot: this.graphTransactionSnapshot() }
        } else if (request.command.type === "activate-graph" && this.graphCandidate) {
          this.graphRevision = this.graphCandidate.graphRevision
          this.lastGraphOperation = {
            operationId: this.graphCandidate.operationId,
            outcome: "committed",
            graphRevision: this.graphCandidate.graphRevision
          }
          this.graphCandidate = null
          value = { type: "activated", snapshot: this.graphTransactionSnapshot() }
        } else if (request.command.type === "abort-graph") {
          const operationId = meta.mutation?.operationId ?? ""
          const existed = this.graphCandidate?.operationId === operationId
          if (existed && this.graphCandidate) {
            this.lastGraphOperation = {
              operationId,
              outcome: "not-committed",
              graphRevision: this.graphCandidate.graphRevision
            }
            this.graphCandidate = null
          }
          value = {
            type: "aborted",
            operationId,
            existed,
            snapshot: this.graphTransactionSnapshot()
          }
        } else {
          value = { type: "snapshot", snapshot: this.graphTransactionSnapshot() }
        }
        return response({
          type: "graph-transaction",
          result: {
            ok: true,
            requestId: meta.requestId,
            ...(meta.mutation ? { operationId: meta.mutation.operationId } : {}),
            resourceRevision: this.graphRevision,
            value,
            warnings: []
          }
        })
      }
      if (request.command.type === "transport") {
        const kind = request.command.command?.kind
        if (kind === "seek") {
          this.positionFrames = request.command.command?.position_frames ?? 0
          this.transportState = 0
        } else if (kind === "play") {
          this.transportState = 1
        } else if (kind === "set-loop") {
          this.loopEnabled = request.command.command?.loop_enabled ?? false
          this.loopStartTick = request.command.command?.loop_start_tick ?? null
          this.loopEndTick = request.command.command?.loop_end_tick ?? null
        } else {
          this.transportState = 0
        }
        return response({
          type: "transport-snapshot",
          transport: {
            state: this.transportState === 1 ? "playing" : "stopped",
            position_frames: this.positionFrames,
            position_ticks: 0,
            sample_rate: this.sessionSampleRate,
            effective_bpm: null,
            clock_source: "internal",
            waiting_for: null,
            loop_enabled: this.loopEnabled,
            loop_start_tick: this.loopStartTick,
            loop_end_tick: this.loopEndTick
          }
        })
      }
      if (request.command.type === "transport-snapshot") {
        return response({
          type: "transport-snapshot",
          transport: {
            state: this.transportState === 1 ? "playing" : "stopped",
            position_frames: this.positionFrames,
            position_ticks: 0,
            sample_rate: this.sessionSampleRate,
            effective_bpm: null,
            clock_source: "internal",
            waiting_for: null,
            loop_enabled: this.loopEnabled,
            loop_start_tick: this.loopStartTick,
            loop_end_tick: this.loopEndTick
          }
        })
      }
      if (request.command.type === "mixer-snapshot") {
        return response({ type: "mixer-snapshot", meters: [] })
      }
      if (request.command.type === "compiled-graph-snapshot") {
        return response({
          type: "compiled-graph-snapshot",
          snapshot:
            this.graphRevision === 0
              ? null
              : {
                  graph_revision: this.graphRevision,
                  build_generation: this.graphRevision,
                  sample_rate: this.sessionSampleRate,
                  nodes: [],
                  edges: []
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
          return response({
            type: "error",
            error: {
              code: "invariant-violation",
              category: "invariant-violation",
              outcome: "quarantined",
              retry: "after-reconcile",
              correlationId: "test-audio-benchmark",
              userMessageKey: "errors.audioBenchmarkFailed",
              details: {
                type: "invariant-violation",
                component: "audio-host"
              }
            }
          })
        }
        const report = {
          type: "audio-benchmark",
          report: {
            duration_ms: 1,
            overall_realtime_factor: 2,
            worst_p99_deadline_utilization_percent: 10,
            scenarios: []
          }
        }
        return this.audioBenchmarkDeferred
          ? this.audioBenchmarkDeferred.promise.then(() => response(report))
          : response(report)
      }
      if (request.command.type === "benchmark-echo") {
        if (this.failIpcBenchmark) {
          this.failIpcBenchmark = false
          return response({
            type: "error",
            error: {
              code: "invariant-violation",
              category: "invariant-violation",
              outcome: "quarantined",
              retry: "after-reconcile",
              correlationId: "test-ipc-benchmark",
              userMessageKey: "errors.audioBenchmarkFailed",
              details: {
                type: "invariant-violation",
                component: "audio-host"
              }
            }
          })
        }
        return response(
          {
            type: "benchmark-echo",
            payload: request.command.payload
          },
          attachments
        )
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

    enqueueParameter(): { outcome: string; sequence: string } {
      return { outcome: "queued", sequence: "1" }
    }

    transportDiagnostics(): Buffer {
      return Buffer.from(
        encode([
          "test-session",
          [0, 0, 256, 0],
          [0, 0, 256, 128 * 1024 * 1024, 0, 0, 0, 0, 0],
          0,
          [1, 1, this.graphRevision, 0, 0, 0],
          [0, 4096, 0, 0, 0, 0],
          false,
          [2, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0]
        ])
      )
    }

    get helperEpoch(): string {
      return "test-session"
    }

    private graphTransactionSnapshot(): Record<string, unknown> {
      return {
        helperEpoch: this.helperEpoch,
        engine: {
          kind: "audio-engine",
          id: "engine",
          epoch: this.helperEpoch,
          generation: 1
        },
        status: this.graphCandidate ? "prepared" : this.graphRevision > 0 ? "active" : "empty",
        committedProjectGraph: null,
        committedRevision: this.graphRevision,
        observedRevision: this.graphRevision,
        candidate: this.graphCandidate,
        lastOperation: this.lastGraphOperation
      }
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

  return { Client, Deferred, runtime }
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
  project: ProjectGraphSnapshot
  runtime: AudioHostGraph
} {
  return {
    project: {
      sampleRate,
      plugins: []
    } as unknown as ProjectGraphSnapshot,
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

function pluginInstance(id = "plugin-1"): PluginInstanceState {
  return {
    id,
    channelId: "audio-1",
    role: "insert",
    slotOrder: 0,
    classId: "test-gain",
    descriptor: {
      source: { kind: "external" },
      classId: "test-gain",
      modulePath: "/tmp/gain.vst3",
      name: "Test Gain",
      vendor: "YADAW",
      version: "1.0",
      categories: ["Fx"],
      kind: "effect",
      architecture: "x86_64",
      buses: [],
      supportedAudioModes: ["stereo"],
      hasEditor: true,
      compatibility: "compatible",
      compatibilityReason: null
    },
    audioMode: "stereo",
    enabled: true,
    componentState: new Uint8Array(),
    controllerState: new Uint8Array()
  }
}

describe("AudioHostService recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fakeHost.Client.instances.length = 0
    fakeHost.Client.failNextAudioBenchmark = false
    fakeHost.Client.failNextIpcBenchmark = false
    fakeHost.Client.deferNextAudioBenchmark = false
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

  it("does not update the committed recovery graph until candidate activation", async () => {
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
    const candidate = graph(48_000)
    const meta = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "open-project",
      mutation: {
        operationId: "open-project-operation",
        idempotencyKey: "open-project-idempotency"
      }
    }
    const projectGraph = {
      kind: "project-graph" as const,
      id: "project:graph",
      epoch: "main-epoch",
      generation: 1
    }

    const prepared = await service.prepareGraphDeployment(
      meta,
      projectGraph,
      1,
      candidate.project,
      candidate.runtime
    )
    expect(prepared.ok).toBe(true)
    expect(
      (
        service as unknown as {
          lastGraph: { revision: number } | null
        }
      ).lastGraph
    ).toBeNull()
    if (!prepared.ok) throw new Error("test setup failed")

    const activated = await service.activateGraphDeployment(prepared.value)
    expect(activated).toMatchObject({ ok: true, value: { type: "activated" } })
    expect(
      (
        service as unknown as {
          lastGraph: { revision: number } | null
        }
      ).lastGraph?.revision
    ).toBe(1)

    await service.stop()
  })

  it("does not unload removed plugins until graph activation", async () => {
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
    const plugin = pluginInstance()
    await service.loadPlugin(plugin, 48_000)
    const candidate = graph(48_000)

    await service.commitDesiredGraph({
      meta: {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "remove-plugin"
      },
      projectGraph: {
        kind: "project-graph",
        id: "project:graph",
        epoch: "main-epoch",
        generation: 1
      },
      baseRevision: 1,
      graphRevision: 2,
      project: candidate.project,
      runtime: candidate.runtime
    })

    const client = fakeHost.Client.instances[0]!
    expect(client.commands.filter((command) => command.type === "unload-plugin")).toEqual([])
    await service.stop()
  })

  it("unloads plugin instances removed from the committed graph after activation", async () => {
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
    const plugin = pluginInstance()
    await service.loadPlugin(plugin, 48_000)
    const candidate = graph(48_000)
    const prepared = await service.prepareGraphDeployment(
      {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "remove-plugin"
      },
      {
        kind: "project-graph",
        id: "project:graph",
        epoch: "main-epoch",
        generation: 1
      },
      2,
      candidate.project,
      candidate.runtime
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error("test setup failed")

    const activated = await service.activateGraphDeployment(prepared.value)
    expect(activated).toMatchObject({ ok: true, value: { type: "activated" } })

    const client = fakeHost.Client.instances[0]!
    expect(client.commands.filter((command) => command.type === "unload-plugin")).toEqual([
      { type: "unload-plugin", instance_id: plugin.id }
    ])
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

  it("runs the complete benchmark in an isolated one-shot helper", async () => {
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
    const primary = fakeHost.Client.instances[0]!

    const result = await service.runAudioBenchmark(effect)
    const benchmarkClient = fakeHost.Client.instances[1]!
    const commandTypes = benchmarkClient.commands.map((command) => command.type)
    const firstBenchmark = commandTypes.indexOf("run-audio-benchmark")
    expect(commandTypes.slice(0, firstBenchmark)).toEqual(Array(64).fill("load-plugin"))
    expect(commandTypes.slice(firstBenchmark, firstBenchmark + 1)).toEqual(["run-audio-benchmark"])
    expect(commandTypes.filter((type) => type === "unload-plugin")).toHaveLength(0)
    expect(commandTypes.filter((type) => type === "benchmark-echo").length).toBeGreaterThan(0)
    expect(result.ipc.scenarios.length).toBeGreaterThan(0)
    expect(primary.commands.some((command) => command.type === "load-plugin")).toBe(false)
    expect(primary.closed).toBe(false)
    expect(benchmarkClient.closed).toBe(true)

    fakeHost.Client.failNextAudioBenchmark = true
    await expect(service.runAudioBenchmark(effect)).rejects.toThrow(
      "audio DSP benchmark failed: errors.audioBenchmarkFailed"
    )
    expect(fakeHost.Client.instances[2]?.closed).toBe(true)

    fakeHost.Client.failNextIpcBenchmark = true
    await expect(service.runAudioBenchmark(effect)).rejects.toThrow(
      "audio IPC benchmark failed: errors.audioBenchmarkFailed"
    )
    expect(fakeHost.Client.instances[3]?.closed).toBe(true)

    await service.stop()
  })

  it("keeps project requests on the primary helper while the isolated benchmark runs", async () => {
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
    const primary = fakeHost.Client.instances[0]!
    await service.audioEngineSnapshot()

    fakeHost.Client.deferNextAudioBenchmark = true
    const benchmark = service.runAudioBenchmark(effect)
    await vi.waitFor(() => expect(fakeHost.Client.instances).toHaveLength(2))
    const benchmarkClient = fakeHost.Client.instances[1]!
    await vi.waitFor(() =>
      expect(
        benchmarkClient.commands.some((command) => command.type === "run-audio-benchmark")
      ).toBe(true)
    )
    const snapshotCommandCount = primary.commands.filter(
      (command) => command.type === "audio-engine-snapshot"
    ).length
    await service.audioEngineSnapshot()
    expect(
      primary.commands.filter((command) => command.type === "audio-engine-snapshot")
    ).toHaveLength(snapshotCommandCount + 1)
    expect(primary.closed).toBe(false)

    benchmarkClient.audioBenchmarkDeferred!.resolve()
    await benchmark
    expect(benchmarkClient.closed).toBe(true)
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
