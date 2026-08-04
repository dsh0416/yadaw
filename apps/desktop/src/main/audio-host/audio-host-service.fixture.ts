import { decode, encode } from "@msgpack/msgpack"
import type { PluginInstanceState, ProjectGraphSnapshot } from "@heron/contracts"
import { vi } from "vitest"

const fakeHostInternal = vi.hoisted(() => {
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
    static failNextNativeBridgeBenchmark = false
    static deferNextAudioBenchmark = false
    static failNextLaunches = 0
    static launchArguments: unknown[][] = []

    readonly commands: Array<Record<string, unknown>> = []
    readonly heartbeatDeferred = new Deferred<{ body: Buffer; attachments: Buffer[] }>()
    readonly delayedEngineStart =
      Client.instances.length === 1 ? new Deferred<{ body: Buffer; attachments: Buffer[] }>() : null
    delayedEngineRequestId = 0
    heartbeatCalls = 0
    closed = false
    closeCalls = 0
    failAudioBenchmark = false
    failNativeBridgeBenchmark = false
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

    constructor(...arguments_: unknown[]) {
      Client.launchArguments.push(arguments_)
      if (Client.failNextLaunches > 0) {
        Client.failNextLaunches -= 1
        throw new Error("simulated helper launch failure")
      }
      this.failAudioBenchmark = Client.failNextAudioBenchmark
      Client.failNextAudioBenchmark = false
      this.failNativeBridgeBenchmark = Client.failNextNativeBridgeBenchmark
      Client.failNextNativeBridgeBenchmark = false
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
        if (this.failNativeBridgeBenchmark) {
          this.failNativeBridgeBenchmark = false
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
          [0, 256, 0],
          0,
          ["test-session", this.graphRevision, 0, 0],
          [256, 0, 0],
          [2, 4]
        ])
      )
    }

    get helperEpoch(): string {
      return "test-session"
    }

    get runtimeEpoch(): string {
      return this.helperEpoch
    }

    get directTelemetry(): boolean {
      return true
    }

    pumpEvents(): void {}

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
      this.closeCalls += 1
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

vi.mock("@heron/dsp-node", () => ({
  AudioHostRuntime: class extends fakeHostInternal.Client {
    heartbeat(payload: Buffer): Promise<{ body: Buffer; attachments: Buffer[] }> {
      return this.heartbeatRequest(payload)
    }
  }
}))

import type { AudioHostGraph } from "./audio-host-service"

export const AudioHostService = (await import("./audio-host-service")).AudioHostService

export function graph(sampleRate: number): {
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

export function pluginInstance(id = "plugin-1"): PluginInstanceState {
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
      vendor: "Heron Studio",
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
    sidechainInputs: [],
    componentState: new Uint8Array(),
    controllerState: new Uint8Array()
  }
}

export const fakeHost = fakeHostInternal

export function resetFakeHost(): void {
  fakeHost.Client.instances.length = 0
  fakeHost.Client.failNextAudioBenchmark = false
  fakeHost.Client.failNextNativeBridgeBenchmark = false
  fakeHost.Client.deferNextAudioBenchmark = false
  fakeHost.Client.failNextLaunches = 0
  fakeHost.Client.launchArguments.length = 0
}
