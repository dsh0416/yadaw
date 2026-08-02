import { decode, encode } from "@msgpack/msgpack"
import type { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type {
  AudioIpcBenchmarkReport,
  AudioIpcBenchmarkScenario,
  AudioIpcPerformanceSnapshot,
  AudioHostRuntimePreferences
} from "@yadaw/contracts"
import { binaryBytes, extractLargeAttachments, inlineBinary, percentile } from "./audio-host-wire"
import type { ControlResponse, TelemetryWire, TransportDiagnosticsWire } from "./audio-host-wire"

export interface AudioHostDiagnosticsState {
  executablePath: string
  runtimePreferences: AudioHostRuntimePreferences
  lastHeartbeatAt: number | null
  lastHeartbeatGenerations: {
    ipc: number
    tokio: number
    winit: number
    callback: number
  }
  lastHostIpcMetrics: {
    egressActive: number
    egressQueueDepth: number
    egressQueueHighWater: number
    egressBatches: number
    blockingJobs: number
    arenaRegions: number
    arenaCapacityBytes: number
    arenaUsedBytes: number
    arenaHighWaterBytes: number
    arenaOffers: number
    arenaBusy: number
    arenaQuarantinedRegions: number
    arenaCopiedBytes: number
  }
}

export class AudioHostDiagnostics {
  constructor(
    private readonly getClient: () => AudioHostIpcClient | null,
    private readonly request: (command: Record<string, unknown>) => Promise<ControlResponse>,
    private readonly state: () => AudioHostDiagnosticsState
  ) {}

  readTelemetry(): TelemetryWire {
    const client = this.getClient()
    if (!client) throw new Error("audio host is not running")
    return decode(client.readTelemetry()) as TelemetryWire
  }

  async runIpcBenchmark(): Promise<AudioIpcBenchmarkReport> {
    const started = performance.now()
    const before = this.performanceDiagnostics()
    const scenarios: AudioIpcBenchmarkScenario[] = []
    scenarios.push(
      await this.measureEchoRoundTrip(
        "inline-control",
        "Inline control payload",
        "256-byte MessagePack request/reply through the helper router",
        "inline-round-trip",
        256,
        200,
        8
      )
    )
    scenarios.push(
      await this.measureEchoRoundTrip(
        "shared-cold-4m",
        "Shared cold first use",
        "First 4 MiB transfer includes lazy arena creation and region-handle mapping",
        "shared-cold",
        4 * 1024 * 1024,
        1,
        0
      )
    )
    scenarios.push(
      await this.measureEchoRoundTrip(
        "shared-warm-sequential-4m",
        "Warm sequential effective throughput",
        "Sequential 4 MiB duplex requests reuse the registered persistent arena",
        "shared-warm-sequential",
        4 * 1024 * 1024,
        24,
        2
      )
    )
    for (const concurrency of [1, 4, 8, 16]) {
      scenarios.push(await this.measureSaturatedArena(concurrency))
    }
    scenarios.push(await this.measureConcurrentRouting())
    scenarios.push(this.measureTelemetryReads())
    const after = this.performanceDiagnostics()
    return {
      durationMs: performance.now() - started,
      buildProfile:
        this.state().executablePath.includes("\\release\\") ||
        this.state().executablePath.includes("/release/")
          ? "release"
          : "debug",
      runtime: after?.runtime.resolved ?? {
        workerThreads: 1,
        maxBlockingThreads: 2,
        egressConcurrency: 1
      },
      arenaOffers: (after?.sharedMemory.arenaOffers ?? 0) - (before?.sharedMemory.arenaOffers ?? 0),
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
    const attachments: Buffer[] = []
    extractLargeAttachments(request, attachments)
    return encode(request).byteLength
  }

  private async measureEchoRoundTrip(
    id: string,
    label: string,
    description: string,
    kind: "inline-round-trip" | "shared-cold" | "shared-warm-sequential",
    payloadBytes: number,
    iterations: number,
    warmupIterations: number
  ): Promise<AudioIpcBenchmarkScenario> {
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
    return this.ipcScenario({
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

  private async measureSaturatedArena(concurrency: number): Promise<AudioIpcBenchmarkScenario> {
    const payload = new Uint8Array(4 * 1024 * 1024)
    payload.fill(0x5a)
    const rounds = Math.max(2, Math.ceil(32 / concurrency))
    const latencyUs: number[] = []
    const echo = async (): Promise<void> => {
      const requestStarted = performance.now()
      const response = await this.request({
        type: "benchmark-echo",
        payload: inlineBinary(payload)
      })
      latencyUs.push((performance.now() - requestStarted) * 1_000)
      if (
        response.result.type !== "benchmark-echo" ||
        binaryBytes(response.result.payload).byteLength !== payload.byteLength
      ) {
        throw new Error("audio host returned an invalid saturated benchmark echo")
      }
    }
    await echo()
    latencyUs.length = 0
    const started = performance.now()
    for (let round = 0; round < rounds; round += 1) {
      await Promise.all(Array.from({ length: concurrency }, echo))
    }
    return this.ipcScenario({
      id: `shared-saturated-4m-${concurrency}`,
      label: `Warm saturated duplex · ${concurrency} in flight`,
      description: "4 MiB persistent-arena duplex bandwidth with concurrent response routing",
      kind: "shared-saturated",
      payloadBytes: payload.byteLength,
      iterations: rounds * concurrency,
      concurrency,
      elapsedMs: performance.now() - started,
      latencyUs
    })
  }

  private async measureConcurrentRouting(): Promise<AudioIpcBenchmarkScenario> {
    const concurrency = 128
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
    return this.ipcScenario({
      id: "concurrent-router",
      label: "Concurrent response routing",
      description: "128 simultaneous requests resolved by request ID",
      kind: "concurrent-routing",
      payloadBytes: payload.byteLength,
      iterations: concurrency,
      concurrency,
      elapsedMs,
      latencyUs
    })
  }

  private measureTelemetryReads(): AudioIpcBenchmarkScenario {
    const iterations = 10_000
    const latencyUs: number[] = []
    const started = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      const iterationStarted = performance.now()
      this.readTelemetry()
      latencyUs.push((performance.now() - iterationStarted) * 1_000)
    }
    return this.ipcScenario({
      id: "telemetry-page",
      label: "Telemetry shared page",
      description: "Synchronous seqlock reads through the native addon",
      kind: "telemetry-read",
      payloadBytes: 0,
      iterations,
      concurrency: 1,
      elapsedMs: performance.now() - started,
      latencyUs
    })
  }

  private ipcScenario(input: {
    id: string
    label: string
    description: string
    kind: AudioIpcBenchmarkScenario["kind"]
    payloadBytes: number
    iterations: number
    concurrency: number
    elapsedMs: number
    latencyUs: readonly number[]
  }): AudioIpcBenchmarkScenario {
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

  performanceDiagnostics(): AudioIpcPerformanceSnapshot | null {
    const client = this.getClient()
    if (!client) return null
    try {
      const diagnostics = decode(client.transportDiagnostics()) as TransportDiagnosticsWire
      const lastHeartbeatAt = this.state().lastHeartbeatAt
      return {
        sessionEpoch: diagnostics[0],
        heartbeat: {
          ageMs: lastHeartbeatAt === null ? null : Date.now() - lastHeartbeatAt,
          ipcGeneration: this.state().lastHeartbeatGenerations.ipc,
          tokioGeneration: this.state().lastHeartbeatGenerations.tokio,
          winitGeneration: this.state().lastHeartbeatGenerations.winit,
          callbackGeneration: this.state().lastHeartbeatGenerations.callback
        },
        requests: {
          normalPending: diagnostics[1][0],
          priorityPending: diagnostics[1][1],
          capacity: diagnostics[1][2],
          timeouts: diagnostics[1][3]
        },
        sharedMemory: {
          outstandingLeases: diagnostics[2][0],
          outstandingBytes: diagnostics[2][1],
          maxLeases: diagnostics[2][2],
          maxBytes: diagnostics[2][3],
          inlinePackets: diagnostics[2][4],
          inlineBytes: diagnostics[2][5],
          sharedPackets: diagnostics[2][6],
          sharedRegions: diagnostics[2][7],
          sharedBytes: diagnostics[2][8],
          arenaRegions: diagnostics[7][3] + this.state().lastHostIpcMetrics.arenaRegions,
          arenaCapacityBytes:
            diagnostics[7][4] + this.state().lastHostIpcMetrics.arenaCapacityBytes,
          arenaUsedBytes: diagnostics[7][5] + this.state().lastHostIpcMetrics.arenaUsedBytes,
          arenaHighWaterBytes:
            diagnostics[7][6] + this.state().lastHostIpcMetrics.arenaHighWaterBytes,
          arenaOffers: diagnostics[7][7] + this.state().lastHostIpcMetrics.arenaOffers,
          arenaBusy: diagnostics[7][8] + this.state().lastHostIpcMetrics.arenaBusy,
          arenaQuarantinedRegions:
            diagnostics[7][9] + this.state().lastHostIpcMetrics.arenaQuarantinedRegions,
          copiedBytes: diagnostics[7][10] + this.state().lastHostIpcMetrics.arenaCopiedBytes
        },
        runtime: {
          requested: structuredClone(this.state().runtimePreferences),
          resolved: {
            workerThreads: diagnostics[7][0],
            maxBlockingThreads: diagnostics[7][1],
            egressConcurrency: diagnostics[7][2]
          },
          egressActive: this.state().lastHostIpcMetrics.egressActive,
          egressQueueDepth: this.state().lastHostIpcMetrics.egressQueueDepth,
          egressQueueHighWater: this.state().lastHostIpcMetrics.egressQueueHighWater,
          egressBatches: this.state().lastHostIpcMetrics.egressBatches,
          blockingJobs: this.state().lastHostIpcMetrics.blockingJobs
        },
        eventQueueDepth: diagnostics[3],
        telemetry: {
          epoch: diagnostics[4][0],
          capacity: diagnostics[4][1],
          graphRevision: diagnostics[4][2],
          callbackGeneration: diagnostics[4][3],
          meterSlots: diagnostics[4][4],
          fallbackReads: diagnostics[4][5]
        },
        parameterRing: {
          used: diagnostics[5][0],
          capacity: diagnostics[5][1],
          softFull: diagnostics[5][2],
          hardFull: diagnostics[5][3],
          boundaryFallbacks: diagnostics[5][4],
          staleEpoch: diagnostics[5][5]
        }
      }
    } catch {
      return null
    }
  }
}
