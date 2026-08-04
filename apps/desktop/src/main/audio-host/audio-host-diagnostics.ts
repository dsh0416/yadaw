import { decode, encode } from "@msgpack/msgpack"
import type { AudioHostRuntime } from "@heron/dsp-node"
import type {
  AudioNativeBenchmarkReport,
  AudioNativeBenchmarkScenario,
  AudioRuntimePerformanceSnapshot,
  AudioHostRuntimePreferences
} from "@heron/contracts"
import { binaryBytes, inlineBinary, percentile } from "./wire"
import type { ControlResponse, TelemetryWire, TransportDiagnosticsWire } from "./wire"

export interface AudioHostDiagnosticsState {
  runtimePreferences: AudioHostRuntimePreferences
  lastHeartbeatAt: number | null
  lastHeartbeatGenerations: {
    ipc: number
    tokio: number
    winit: number
    callback: number
  }
}

export class AudioHostDiagnostics {
  constructor(
    private readonly getClient: () => AudioHostRuntime | null,
    private readonly request: (command: Record<string, unknown>) => Promise<ControlResponse>,
    private readonly state: () => AudioHostDiagnosticsState
  ) {}

  readTelemetry(): TelemetryWire {
    const client = this.getClient()
    if (!client) throw new Error("audio host is not running")
    return decode(client.readTelemetry()) as TelemetryWire
  }

  async runNativeBenchmark(): Promise<AudioNativeBenchmarkReport> {
    const started = performance.now()
    const scenarios: AudioNativeBenchmarkScenario[] = []
    scenarios.push(
      await this.measureEchoRoundTrip(
        "inline-control",
        "Embedded control payload",
        "256-byte MessagePack request/reply through the in-process native boundary",
        "request-round-trip",
        256,
        50,
        4
      )
    )
    scenarios.push(await this.measureConcurrentRouting())
    scenarios.push(this.measureTelemetryReads())
    const after = this.performanceDiagnostics()
    return {
      durationMs: performance.now() - started,
      buildProfile: process.env.NODE_ENV === "production" ? "release" : "debug",
      runtime: after?.runtime.resolved ?? {
        workerThreads: 1,
        maxBlockingThreads: 2
      },
      messagePackBodyBytes: this.benchmarkMessagePackBodyBytes(4 * 1024 * 1024),
      scenarios
    }
  }

  private benchmarkMessagePackBodyBytes(payloadBytes: number): number {
    const request = {
      request_id: 0,
      command: {
        type: "benchmark-echo",
        payload: inlineBinary(new Uint8Array(payloadBytes))
      }
    }
    return encode(request).byteLength
  }

  private async measureEchoRoundTrip(
    id: string,
    label: string,
    description: string,
    kind: "request-round-trip",
    payloadBytes: number,
    iterations: number,
    warmupIterations: number
  ): Promise<AudioNativeBenchmarkScenario> {
    const payload = new Uint8Array(payloadBytes)
    payload.fill(0xa5)
    const echo = async (): Promise<void> => {
      const response = await this.request({
        type: "benchmark-echo",
        payload: inlineBinary(payload)
      })
      if (
        response.result.type !== "benchmark-echo" ||
        binaryBytes(response.result.payload).byteLength !== payloadBytes
      ) {
        throw new Error("audio host returned an invalid benchmark echo")
      }
    }
    for (let index = 0; index < warmupIterations; index += 1) await echo()
    const latencyUs: number[] = []
    const started = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      const iterationStarted = performance.now()
      await echo()
      latencyUs.push((performance.now() - iterationStarted) * 1_000)
    }
    const elapsedMs = performance.now() - started
    return this.nativeScenario({
      id,
      label,
      description,
      kind,
      payloadBytes,
      iterations,
      concurrency: 1,
      elapsedMs,
      latencyUs
    })
  }

  private async measureConcurrentRouting(): Promise<AudioNativeBenchmarkScenario> {
    const concurrency = 32
    const payload = new Uint8Array(256)
    const latencyUs: number[] = []
    const started = performance.now()
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const requestStarted = performance.now()
        const response = await this.request({
          type: "benchmark-echo",
          payload: inlineBinary(payload)
        })
        latencyUs.push((performance.now() - requestStarted) * 1_000)
        if (response.result.type !== "benchmark-echo") {
          throw new Error("audio host returned an invalid concurrent benchmark echo")
        }
      })
    )
    const elapsedMs = performance.now() - started
    return this.nativeScenario({
      id: "concurrent-router",
      label: "Concurrent response routing",
      description: "32 simultaneous in-process requests resolved by request ID",
      kind: "concurrent-routing",
      payloadBytes: payload.byteLength,
      iterations: concurrency,
      concurrency,
      elapsedMs,
      latencyUs
    })
  }

  private measureTelemetryReads(): AudioNativeBenchmarkScenario {
    const iterations = 1_000
    const latencyUs: number[] = []
    const started = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      const iterationStarted = performance.now()
      this.readTelemetry()
      latencyUs.push((performance.now() - iterationStarted) * 1_000)
    }
    return this.nativeScenario({
      id: "direct-telemetry",
      label: "Direct telemetry read",
      description: "Synchronous engine snapshot reads through the native addon",
      kind: "telemetry-read",
      payloadBytes: 0,
      iterations,
      concurrency: 1,
      elapsedMs: performance.now() - started,
      latencyUs
    })
  }

  private nativeScenario(input: {
    id: string
    label: string
    description: string
    kind: AudioNativeBenchmarkScenario["kind"]
    payloadBytes: number
    iterations: number
    concurrency: number
    elapsedMs: number
    latencyUs: readonly number[]
  }): AudioNativeBenchmarkScenario {
    const elapsedSeconds = input.elapsedMs / 1_000
    const transferredBytes = input.payloadBytes * input.iterations * 2
    return {
      id: input.id,
      label: input.label,
      description: input.description,
      kind: input.kind,
      payloadBytes: input.payloadBytes,
      iterations: input.iterations,
      concurrency: input.concurrency,
      elapsedMs: input.elapsedMs,
      operationsPerSecond: input.iterations / Math.max(elapsedSeconds, Number.EPSILON),
      throughputMiBPerSecond:
        input.payloadBytes === 0
          ? null
          : transferredBytes / (1024 * 1024) / Math.max(elapsedSeconds, Number.EPSILON),
      latencyP50Us: percentile(input.latencyUs, 0.5),
      latencyP95Us: percentile(input.latencyUs, 0.95),
      latencyP99Us: percentile(input.latencyUs, 0.99)
    }
  }

  performanceDiagnostics(): AudioRuntimePerformanceSnapshot | null {
    const client = this.getClient()
    if (!client) return null
    try {
      const diagnostics = decode(client.transportDiagnostics()) as TransportDiagnosticsWire
      const lastHeartbeatAt = this.state().lastHeartbeatAt
      return {
        sessionEpoch: diagnostics[0],
        heartbeat: {
          ageMs: lastHeartbeatAt === null ? null : Date.now() - lastHeartbeatAt,
          controlGeneration: this.state().lastHeartbeatGenerations.ipc,
          tokioGeneration: this.state().lastHeartbeatGenerations.tokio,
          winitGeneration: this.state().lastHeartbeatGenerations.winit,
          callbackGeneration: this.state().lastHeartbeatGenerations.callback
        },
        requests: {
          normalPending: diagnostics[1][0],
          capacity: diagnostics[1][1],
          slowRequests: diagnostics[1][2]
        },
        runtime: {
          requested: structuredClone(this.state().runtimePreferences),
          resolved: {
            workerThreads: diagnostics[5][0],
            maxBlockingThreads: diagnostics[5][1]
          }
        },
        eventQueueDepth: diagnostics[2],
        telemetry: {
          epoch: diagnostics[3][0],
          capacity: 256,
          graphRevision: diagnostics[3][1],
          callbackGeneration: diagnostics[3][2],
          meterSlots: diagnostics[3][3],
          fallbackReads: 0
        },
        parameterRing: {
          used: 0,
          capacity: diagnostics[4][0],
          softFull: 0,
          hardFull: diagnostics[4][1],
          boundaryFallbacks: 0,
          staleEpoch: diagnostics[4][2]
        }
      }
    } catch {
      return null
    }
  }
}
