import type { AudioHostRuntime } from "@heron/dsp-node"
import type { AudioHostDiagnosticsState } from "./audio-host-diagnostics"
import type { PriorityResponse } from "./wire"

const HEARTBEAT_INTERVAL_MS = 250
const HEARTBEAT_TIMEOUT_MS = 2_000

type HealthSnapshot = Pick<
  AudioHostDiagnosticsState,
  "lastHeartbeatAt" | "lastHeartbeatGenerations"
>

interface AudioHostHealthMonitorOptions {
  currentClient: () => AudioHostRuntime | null
  heartbeat: (client: AudioHostRuntime) => Promise<PriorityResponse>
  captureTransport: (client: AudioHostRuntime) => void
  onFailure: (client: AudioHostRuntime, message: string) => void
}

export class AudioHostHealthMonitor {
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private failureReported = false
  private benchmarkActive = false
  private benchmarkGeneration = 0
  private lastCallbackGeneration: number | null = null
  private callbackStagnantSince = 0
  private state: HealthSnapshot = this.emptySnapshot()

  constructor(private readonly options: AudioHostHealthMonitorOptions) {}

  start(client: AudioHostRuntime): void {
    this.stop()
    this.state = this.emptySnapshot()
    this.failureReported = false
    this.lastCallbackGeneration = null
    this.callbackStagnantSince = 0
    this.heartbeatTimer = setInterval(() => this.poll(client), HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
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

  private poll(client: AudioHostRuntime): void {
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
        this.reportFailure(client, `heartbeat failed: ${message}`)
      })
      .finally(() => {
        if (this.options.currentClient() === client) this.heartbeatInFlight = false
      })
  }

  private acceptHeartbeat(client: AudioHostRuntime, response: PriorityResponse): void {
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
      this.reportFailure(client, "audio callback made no progress for 2 seconds")
    }
  }

  private reportFailure(client: AudioHostRuntime, message: string): void {
    if (this.failureReported) return
    this.failureReported = true
    this.options.onFailure(client, message)
  }

  private emptySnapshot(): HealthSnapshot {
    return {
      lastHeartbeatAt: null,
      lastHeartbeatGenerations: { ipc: 0, tokio: 0, winit: 0, callback: 0 }
    }
  }
}
