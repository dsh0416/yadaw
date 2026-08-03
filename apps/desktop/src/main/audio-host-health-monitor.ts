import type { AudioHostIpcClient } from "@heron/audio-host-client"
import type { AudioHostDiagnosticsState } from "./audio-host-diagnostics"
import type { PriorityResponse } from "./audio-host-wire"

const HEARTBEAT_INTERVAL_MS = 250
const HEARTBEAT_TIMEOUT_MS = 2_000

type HealthSnapshot = Pick<
  AudioHostDiagnosticsState,
  "lastHeartbeatAt" | "lastHeartbeatGenerations" | "lastHostIpcMetrics"
>

interface AudioHostHealthMonitorOptions {
  currentClient: () => AudioHostIpcClient | null
  heartbeat: (client: AudioHostIpcClient) => Promise<PriorityResponse>
  captureTransport: (client: AudioHostIpcClient) => void
  onFailure: (client: AudioHostIpcClient, message: string) => void
  onStable: (client: AudioHostIpcClient) => void
}

export class AudioHostHealthMonitor {
  private heartbeatTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private benchmarkActive = false
  private benchmarkGeneration = 0
  private lastCallbackGeneration: number | null = null
  private callbackStagnantSince = 0
  private state: HealthSnapshot = this.emptySnapshot()

  constructor(private readonly options: AudioHostHealthMonitorOptions) {}

  start(client: AudioHostIpcClient): void {
    this.stop()
    this.state = this.emptySnapshot()
    this.lastCallbackGeneration = null
    this.callbackStagnantSince = 0
    this.heartbeatTimer = setInterval(() => this.poll(client), HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
    this.stableTimer = setTimeout(() => this.options.onStable(client), 5_000)
    this.stableTimer.unref()
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.heartbeatTimer = null
    this.stableTimer = null
    this.heartbeatInFlight = false
  }

  beginBenchmark(): number {
    this.benchmarkGeneration += 1
    this.benchmarkActive = true
    return this.benchmarkGeneration
  }

  endBenchmark(generation: number): void {
    if (generation === this.benchmarkGeneration) this.benchmarkActive = false
  }

  isBenchmarkActive(): boolean {
    return this.benchmarkActive
  }

  snapshot(): HealthSnapshot {
    return structuredClone(this.state)
  }

  private poll(client: AudioHostIpcClient): void {
    if (this.options.currentClient() !== client || this.heartbeatInFlight || this.benchmarkActive) {
      return
    }
    const benchmarkGeneration = this.benchmarkGeneration
    this.heartbeatInFlight = true
    void this.options
      .heartbeat(client)
      .then((response) => this.acceptHeartbeat(client, response))
      .catch((error: unknown) => {
        if (
          this.benchmarkActive ||
          this.benchmarkGeneration !== benchmarkGeneration ||
          this.options.currentClient() !== client
        ) {
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        this.options.onFailure(client, `heartbeat failed: ${message}`)
      })
      .finally(() => {
        if (this.options.currentClient() === client) this.heartbeatInFlight = false
      })
  }

  private acceptHeartbeat(client: AudioHostIpcClient, response: PriorityResponse): void {
    if (this.options.currentClient() !== client || response.result.type !== "heartbeat") return
    this.options.captureTransport(client)
    const generation = response.result.callback_generation ?? 0
    this.state = {
      lastHeartbeatAt: Date.now(),
      lastHeartbeatGenerations: {
        ipc: response.result.ipc_generation ?? 0,
        tokio: response.result.tokio_generation ?? 0,
        winit: response.result.winit_generation ?? 0,
        callback: generation
      },
      lastHostIpcMetrics: {
        egressActive: response.result.egress_active ?? 0,
        egressQueueDepth: response.result.egress_queue_depth ?? 0,
        egressQueueHighWater: response.result.egress_queue_high_water ?? 0,
        egressBatches: response.result.egress_batches ?? 0,
        blockingJobs: response.result.blocking_jobs ?? 0,
        arenaRegions: response.result.arena_regions ?? 0,
        arenaCapacityBytes: response.result.arena_capacity_bytes ?? 0,
        arenaUsedBytes: response.result.arena_used_bytes ?? 0,
        arenaHighWaterBytes: response.result.arena_high_water_bytes ?? 0,
        arenaOffers: response.result.arena_offers ?? 0,
        arenaBusy: response.result.arena_busy ?? 0,
        arenaQuarantinedRegions: response.result.arena_quarantined_regions ?? 0,
        arenaCopiedBytes: response.result.arena_copied_bytes ?? 0
      }
    }
    const active =
      response.result.transport_state === "playing" ||
      response.result.transport_state === "recording"
    if (!active || generation !== this.lastCallbackGeneration) {
      this.lastCallbackGeneration = generation
      this.callbackStagnantSince = Date.now()
      return
    }
    if (this.callbackStagnantSince === 0) this.callbackStagnantSince = Date.now()
    if (Date.now() - this.callbackStagnantSince >= HEARTBEAT_TIMEOUT_MS) {
      this.options.onFailure(client, "audio callback made no progress for 2 seconds")
    }
  }

  private emptySnapshot(): HealthSnapshot {
    return {
      lastHeartbeatAt: null,
      lastHeartbeatGenerations: { ipc: 0, tokio: 0, winit: 0, callback: 0 },
      lastHostIpcMetrics: {
        egressActive: 0,
        egressQueueDepth: 0,
        egressQueueHighWater: 0,
        egressBatches: 0,
        blockingJobs: 0,
        arenaRegions: 0,
        arenaCapacityBytes: 0,
        arenaUsedBytes: 0,
        arenaHighWaterBytes: 0,
        arenaOffers: 0,
        arenaBusy: 0,
        arenaQuarantinedRegions: 0,
        arenaCopiedBytes: 0
      }
    }
  }
}
