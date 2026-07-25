import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { decode, encode } from "@msgpack/msgpack"
import type {
  PluginInstanceState,
  PluginParameterChange,
  PluginParameterInfo
} from "@yadaw/contracts"

const PROTOCOL_VERSION = 1
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const HEARTBEAT_INTERVAL_MS = 250
const HEARTBEAT_TIMEOUT_MS = 2_000

interface ControlResponse {
  version: number
  request_id: number
  result: {
    type:
      | "pong"
      | "accepted"
      | "plugin-loaded"
      | "plugin-parameters"
      | "plugin-state"
      | "error"
    message?: string
    latency_samples?: number
    tail_samples?: number | null
    parameters?: Array<{
      id: number
      title: string
      units: string
      step_count: number
      default_normalized: number
      normalized: number
      flags: number
    }>
    component_state?: Uint8Array
    controller_state?: Uint8Array
  }
}

interface PendingRequest {
  resolve: (value: ControlResponse) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export class AudioHostService {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdout = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private heartbeat: NodeJS.Timeout | null = null
  private restartBudget = 1
  private stopping = false
  private lastGraphRevision: number | null = null
  private readonly loadedPlugins = new Map<string, {
    latencySamples: number
    tailSamples: number | null
  }>()

  constructor(
    private readonly executablePath: string,
    private readonly bridgePath: string,
    private readonly onFailure: (message: string) => void
  ) {}

  start(): void {
    if (this.child || this.stopping) return
    const child = spawn(this.executablePath, ["--vst3-bridge", this.bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    })
    this.child = child
    this.stdout = Buffer.alloc(0)
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (message: string) => {
      console.error(`[audio-host] ${message.trimEnd()}`)
    })
    child.once("error", (error) => this.handleExit(`could not start: ${error.message}`))
    child.once("exit", (code, signal) => {
      this.handleExit(`exited (${signal ?? code ?? "unknown"})`)
    })
    this.heartbeat = setInterval(() => {
      void this.request({ type: "ping" }).catch((error) => {
        this.handleExit(`heartbeat failed: ${error.message}`)
      })
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
    if (this.lastGraphRevision !== null) {
      void this.request({ type: "load-graph", revision: this.lastGraphRevision }).catch((error) => {
        this.handleExit(`could not restore graph: ${error.message}`)
      })
    }
  }

  async loadGraph(revision: number): Promise<void> {
    this.lastGraphRevision = revision
    await this.request({ type: "load-graph", revision })
  }

  async loadPlugin(plugin: PluginInstanceState, sampleRate: number): Promise<{
    latencySamples: number
    tailSamples: number | null
  }> {
    const existing = this.loadedPlugins.get(plugin.id)
    if (existing) return existing
    const response = await this.request({
      type: "load-plugin",
      instance_id: plugin.id,
      module_path: plugin.descriptor.modulePath,
      class_id: plugin.classId,
      sample_rate: sampleRate,
      component_state: plugin.componentState,
      controller_state: plugin.controllerState
    })
    if (response.result.type !== "plugin-loaded") {
      throw new Error("audio host returned an invalid plugin load response")
    }
    const status = {
      latencySamples: response.result.latency_samples ?? 0,
      tailSamples: response.result.tail_samples ?? null
    }
    this.loadedPlugins.set(plugin.id, status)
    return status
  }

  async pluginParameters(instanceId: string): Promise<PluginParameterInfo[]> {
    const response = await this.request({
      type: "plugin-parameters",
      instance_id: instanceId
    })
    if (response.result.type !== "plugin-parameters") {
      throw new Error("audio host returned an invalid parameter response")
    }
    return (response.result.parameters ?? []).map((parameter) => ({
      id: parameter.id,
      title: parameter.title,
      shortTitle: parameter.title,
      units: parameter.units,
      stepCount: parameter.step_count,
      defaultNormalized: parameter.default_normalized,
      normalized: parameter.normalized,
      flags: parameter.flags
    }))
  }

  async setPluginParameter(change: PluginParameterChange): Promise<void> {
    await this.request({
      type: "set-plugin-parameter",
      instance_id: change.instanceId,
      parameter_id: change.parameterId,
      normalized: change.normalized,
      gesture: change.gesture
    })
  }

  async savePluginState(instanceId: string): Promise<{
    componentState: Uint8Array
    controllerState: Uint8Array
  }> {
    const response = await this.request({
      type: "save-plugin-state",
      instance_id: instanceId
    })
    if (response.result.type !== "plugin-state") {
      throw new Error("audio host returned an invalid plugin state response")
    }
    return {
      componentState: response.result.component_state ?? new Uint8Array(),
      controllerState: response.result.controller_state ?? new Uint8Array()
    }
  }

  private request(command: Record<string, unknown>): Promise<ControlResponse> {
    const child = this.child
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error("audio host is not running"))
    }
    const requestId = this.nextRequestId++
    const payload = Buffer.from(encode({
      version: PROTOCOL_VERSION,
      request_id: requestId,
      command
    }))
    if (payload.length > MAX_MESSAGE_BYTES) {
      return Promise.reject(new Error("audio host message exceeds 64 MiB"))
    }
    const frame = Buffer.allocUnsafe(payload.length + 4)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return new Promise<ControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error("audio host did not respond within 2 seconds"))
      }, HEARTBEAT_TIMEOUT_MS)
      timer.unref()
      this.pending.set(requestId, { resolve, reject, timer })
      child.stdin.write(frame, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }

  private consume(chunk: Buffer): void {
    this.stdout = Buffer.concat([this.stdout, chunk])
    while (this.stdout.length >= 4) {
      const length = this.stdout.readUInt32BE(0)
      if (length > MAX_MESSAGE_BYTES) {
        this.handleExit("sent an oversized protocol message")
        return
      }
      if (this.stdout.length < length + 4) return
      const payload = this.stdout.subarray(4, length + 4)
      this.stdout = this.stdout.subarray(length + 4)
      let response: ControlResponse
      try {
        response = decode(payload) as ControlResponse
      } catch (error) {
        this.handleExit(`sent invalid MessagePack: ${String(error)}`)
        return
      }
      const pending = this.pending.get(response.request_id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(response.request_id)
      if (response.version !== PROTOCOL_VERSION) {
        pending.reject(new Error(`unsupported audio host protocol ${response.version}`))
      } else if (response.result.type === "error") {
        pending.reject(new Error(response.result.message ?? "audio host request failed"))
      } else {
        pending.resolve(response)
      }
    }
  }

  private handleExit(message: string): void {
    const child = this.child
    if (!child) return
    this.child = null
    this.loadedPlugins.clear()
    child.removeAllListeners()
    if (!child.killed) child.kill()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(message))
    }
    this.pending.clear()
    if (!this.stopping) this.onFailure(message)
    if (!this.stopping && this.restartBudget > 0) {
      this.restartBudget -= 1
      this.start()
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const child = this.child
    if (!child) return
    try {
      await this.request({ type: "shutdown" })
    } catch {
      child.kill()
    }
    this.child = null
  }
}
