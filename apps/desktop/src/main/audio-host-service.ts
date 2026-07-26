import { readFileSync } from "node:fs"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type {
  AudioBackendDescriptor,
  AudioDeviceList,
  AudioPreferences,
  AudioRuntimeSnapshot,
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  PluginInstanceState,
  PluginParameterChange,
  PluginParameterInfo,
  TransportCommand,
  TransportSnapshot
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
      | "heartbeat"
      | "accepted"
      | "audio-backends"
      | "audio-devices"
      | "audio-runtime"
      | "mixer-snapshot"
      | "transport-snapshot"
      | "recording-stopped"
      | "recording-waveform"
      | "plugin-loaded"
      | "plugin-parameters"
      | "plugin-state"
      | "plugin-editor"
      | "error"
    message?: string
    callback_generation?: number
    transport_state?: string
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
    editor_kind?: string
    open?: boolean
    backends?: AudioBackendDescriptor[]
    devices?: {
      inputs: AudioHostDevice[]
      outputs: AudioHostDevice[]
    }
    runtime?: AudioHostRuntime
    meters?: AudioHostMeter[]
    transport?: AudioHostTransport
    recording?: AudioHostRecordingResultWire
    waveform?: AudioHostWaveformWire
  }
}

interface AudioHostDevice {
  id: string
  name: string
  is_default: boolean
  default_sample_rate: number | null
  min_buffer_size: number | null
  max_buffer_size: number | null
  channel_count: number | null
}

interface AudioHostRuntime {
  state: string
  requested_buffer_size: number | null
  sample_rate: number | null
  input_sample_rate: number | null
  input_buffer_size: number | null
  output_buffer_size: number | null
  ring_buffer_capacity_frames: number | null
  ring_buffer_fill_frames: number | null
  input_latency_ms: number | null
  output_latency_ms: number | null
  ring_buffer_latency_ms: number | null
  engine_latency_ms: number | null
  estimated_round_trip_latency_ms: number | null
  xruns: number
  clock_sync: string
  buffer_fallback: boolean
}

interface AudioHostMeter {
  channel_id: string
  pre_left: number
  pre_right: number
  post_left: number
  post_right: number
  held_left: number
  held_right: number
  clipped: boolean
}

interface AudioHostTransport {
  state: string
  position_frames: number
  sample_rate: number
}

export interface AudioHostGraph {
  sample_rate: number
  channels: Array<{
    id: string
    kind: string
    gain_db: number
    pan: number
    muted: boolean
    soloed: boolean
    output_index?: number
    record_armed: boolean
    input_channels: number[]
    hardware_output_channels: number[]
  }>
  sends: Array<{
    id: string
    source_index: number
    target_index: number
    enabled: boolean
    tap: string
    level_db: number
    pan: number
  }>
  clips: Array<{
    id: string
    channel_index: number
    start_frame: number
    source_offset_frames: number
    length_frames: number
    path: string
  }>
  plugins: Array<{
    instance_id: string
    channel_index: number
    role: string
    slot_order: number
    enabled: boolean
    latency_samples: number
    tail_samples: number | null
  }>
  midi_clips: Array<{
    id: string
    channel_index: number
    start_tick: number
    source_offset_ticks: number
    length_ticks: number
    notes: Array<{
      start_tick: number
      duration_ticks: number
      channel: number
      key: number
      velocity: number
      release_velocity: number
    }>
  }>
  tempo_events: Array<{ tick: number; beats_per_minute: number }>
  time_signature_events: Array<{
    tick: number
    numerator: number
    denominator: number
  }>
}

export interface AudioHostRecordingConfig {
  path: string
  assetId: string
  originator: string
  originationDate: string
  originationTime: string
  timeReference: number
}

interface AudioHostRecordingResultWire {
  path: string
  sample_rate: number
  channels: number
  frame_count: number
  dropout_frames: number
}

interface AudioHostWaveformWire {
  sample_rate: number
  channels: number
  frame_count: number
  start_frame: number
  end_frame: number
  frames_per_bucket: number
  bucket_count: number
  peaks: Uint8Array
}

export interface AudioHostRecordingResult {
  path: string
  sampleRate: number
  channels: number
  frameCount: number
  dropoutFrames: number
}

export interface AudioHostWaveform {
  sampleRate: number
  channels: number
  frameCount: number
  startFrame: number
  endFrame: number
  framesPerBucket: number
  bucketCount: number
  peaks: Uint8Array
}

export class AudioHostService {
  private client: AudioHostIpcClient | null = null
  private readonly pendingRequests = new Set<Promise<ControlResponse>>()
  private nextRequestId = 1
  private heartbeat: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private lastCallbackGeneration: number | null = null
  private callbackStagnantSince = 0
  private restartBudget = 1
  private readonly recoveryBypassed = new Set<string>()
  private stopping = false
  private lastGraph: {
    revision: number
    project: MixerGraphSnapshot
    runtime: AudioHostGraph
  } | null = null
  private readonly loadedPlugins = new Map<string, {
    latencySamples: number
    tailSamples: number | null
  }>()

  constructor(
    private readonly executablePath: string,
    private readonly bridgePath: string,
    private readonly crashMarkerPath: string,
    private readonly onFailure: (message: string) => void
  ) {}

  start(): void {
    if (this.client || this.stopping) return
    let client: AudioHostIpcClient
    try {
      client = new AudioHostIpcClient(
        this.executablePath,
        this.bridgePath,
        this.crashMarkerPath
      )
    } catch (error) {
      this.onFailure(`could not start audio host: ${String(error)}`)
      return
    }
    this.client = client
    this.lastCallbackGeneration = null
    this.callbackStagnantSince = 0
    this.heartbeat = setInterval(() => {
      void this.request({ type: "ping" }).then((response) => {
        if (response.result.type !== "heartbeat") return
        const generation = response.result.callback_generation ?? 0
        const active = response.result.transport_state === "playing" ||
          response.result.transport_state === "recording"
        if (!active || generation !== this.lastCallbackGeneration) {
          this.lastCallbackGeneration = generation
          this.callbackStagnantSince = Date.now()
          return
        }
        if (this.callbackStagnantSince === 0) this.callbackStagnantSince = Date.now()
        if (Date.now() - this.callbackStagnantSince >= HEARTBEAT_TIMEOUT_MS) {
          this.handleExit("audio callback made no progress for 2 seconds")
        }
      }).catch((error) => {
        this.handleExit(`heartbeat failed: ${error.message}`)
      })
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
    this.stableTimer = setTimeout(() => {
      if (this.client === client) this.restartBudget = 1
    }, 5_000)
    this.stableTimer.unref()
    if (this.lastGraph) void this.restoreGraph().catch((error) => {
      this.handleExit(`could not restore graph: ${error.message}`)
    })
  }

  async loadGraph(
    revision: number,
    project: MixerGraphSnapshot,
    runtime: AudioHostGraph
  ): Promise<void> {
    this.lastGraph = {
      revision,
      project: structuredClone(project),
      runtime: structuredClone(runtime)
    }
    await this.restoreGraph()
  }

  private async restoreGraph(): Promise<void> {
    const graph = this.lastGraph
    if (!graph) return
    const loaded = await Promise.allSettled(
      graph.project.plugins.map((plugin) => this.loadPlugin(plugin, graph.project.sampleRate))
    )
    for (const [index, result] of loaded.entries()) {
      if (result.status === "rejected") {
        console.error(
          `Could not restore VST3 instance ${graph.project.plugins[index]?.id}:`,
          result.reason
        )
      }
    }
    const runtime = structuredClone(graph.runtime)
    runtime.plugins = runtime.plugins.map((plugin) => {
      const status = this.loadedPlugins.get(plugin.instance_id)
      return {
        ...plugin,
        enabled: plugin.enabled && !this.recoveryBypassed.has(plugin.instance_id),
        latency_samples: status?.latencySamples ?? 0,
        tail_samples: status?.tailSamples ?? 0
      }
    })
    await this.request({
      type: "load-graph",
      revision: graph.revision,
      graph: runtime
    })
  }

  async listAudioBackends(): Promise<AudioBackendDescriptor[]> {
    const response = await this.request({ type: "list-audio-backends" })
    if (response.result.type !== "audio-backends") {
      throw new Error("audio host returned an invalid backend response")
    }
    return response.result.backends ?? []
  }

  async listAudioDevices(backend: string): Promise<AudioDeviceList> {
    const response = await this.request({ type: "list-audio-devices", backend })
    if (response.result.type !== "audio-devices" || !response.result.devices) {
      throw new Error("audio host returned an invalid device response")
    }
    const convert = (device: AudioHostDevice) => ({
      id: device.id,
      name: device.name,
      isDefault: device.is_default,
      defaultSampleRate: device.default_sample_rate,
      minBufferSize: device.min_buffer_size,
      maxBufferSize: device.max_buffer_size,
      channelCount: device.channel_count
    })
    return {
      inputs: response.result.devices.inputs.map(convert),
      outputs: response.result.devices.outputs.map(convert)
    }
  }

  async startAudioEngine(preferences: AudioPreferences): Promise<AudioRuntimeSnapshot> {
    const response = await this.request({
      type: "start-audio-engine",
      config: {
        backend: preferences.backend,
        input_device_id: preferences.inputDeviceId,
        output_device_id: preferences.outputDeviceId,
        buffer_size: preferences.bufferSize
      }
    })
    return this.runtimeResult(response)
  }

  async stopAudioEngine(): Promise<AudioRuntimeSnapshot> {
    return this.runtimeResult(await this.request({ type: "stop-audio-engine" }))
  }

  async audioEngineSnapshot(): Promise<AudioRuntimeSnapshot> {
    return this.runtimeResult(await this.request({ type: "audio-engine-snapshot" }))
  }

  private runtimeResult(response: ControlResponse): AudioRuntimeSnapshot {
    const value = response.result.runtime
    if (response.result.type !== "audio-runtime" || !value) {
      throw new Error("audio host returned an invalid runtime response")
    }
    return {
      state: value.state === "running" || value.state === "error" ? value.state : "stopped",
      requestedBufferSize: value.requested_buffer_size,
      sampleRate: value.sample_rate,
      inputSampleRate: value.input_sample_rate,
      inputBufferSize: value.input_buffer_size,
      outputBufferSize: value.output_buffer_size,
      ringBufferCapacityFrames: value.ring_buffer_capacity_frames,
      ringBufferFillFrames: value.ring_buffer_fill_frames,
      inputLatencyMs: value.input_latency_ms,
      outputLatencyMs: value.output_latency_ms,
      ringBufferLatencyMs: value.ring_buffer_latency_ms,
      engineLatencyMs: value.engine_latency_ms,
      estimatedRoundTripLatencyMs: value.estimated_round_trip_latency_ms,
      xruns: value.xruns,
      clockSync: value.clock_sync === "shared-device" ||
        value.clock_sync === "adaptive-resampled"
        ? value.clock_sync
        : "inactive",
      bufferFallback: value.buffer_fallback
    }
  }

  async previewMixerParameter(preview: MixerParameterPreview): Promise<void> {
    await this.request({
      type: "preview-mixer-parameter",
      preview: {
        target: preview.target,
        id: preview.id,
        parameter: preview.parameter,
        value: preview.value
      }
    })
  }

  async mixerSnapshot(): Promise<MixerRuntimeSnapshot> {
    const response = await this.request({ type: "mixer-snapshot" })
    if (response.result.type !== "mixer-snapshot") {
      throw new Error("audio host returned an invalid mixer snapshot")
    }
    return {
      meters: (response.result.meters ?? []).map((meter) => ({
        channelId: meter.channel_id,
        preFaderPeak: [meter.pre_left, meter.pre_right],
        postFaderPeak: [meter.post_left, meter.post_right],
        heldPeak: [meter.held_left, meter.held_right],
        clipped: meter.clipped
      })),
      capturedAt: Date.now()
    }
  }

  async clearMeterClips(): Promise<MixerRuntimeSnapshot> {
    await this.request({ type: "clear-meter-clips" })
    return this.mixerSnapshot()
  }

  async transport(command: TransportCommand): Promise<TransportSnapshot> {
    const response = await this.request({
      type: "transport",
      command: {
        kind: command.type,
        position_frames: command.type === "seek" ? command.positionFrames : null
      }
    })
    return this.transportResult(response)
  }

  async transportSnapshot(): Promise<TransportSnapshot> {
    return this.transportResult(await this.request({ type: "transport-snapshot" }))
  }

  private transportResult(response: ControlResponse): TransportSnapshot {
    const value = response.result.transport
    if (response.result.type !== "transport-snapshot" || !value) {
      throw new Error("audio host returned an invalid transport snapshot")
    }
    return {
      state: value.state === "playing" || value.state === "recording"
        ? value.state
        : "stopped",
      positionFrames: value.position_frames,
      sampleRate: value.sample_rate
    }
  }

  startRecording(config: AudioHostRecordingConfig): Promise<void> {
    return this.request({
      type: "start-recording",
      config: {
        path: config.path,
        asset_id: config.assetId,
        originator: config.originator,
        origination_date: config.originationDate,
        origination_time: config.originationTime,
        time_reference: config.timeReference
      }
    }).then(() => undefined)
  }

  async stopRecording(): Promise<AudioHostRecordingResult> {
    const response = await this.request({ type: "stop-recording" })
    if (response.result.type !== "recording-stopped" || !response.result.recording) {
      throw new Error("audio host returned an invalid recording result")
    }
    const recording = response.result.recording
    return {
      path: recording.path,
      sampleRate: recording.sample_rate,
      channels: recording.channels,
      frameCount: recording.frame_count,
      dropoutFrames: recording.dropout_frames
    }
  }

  async recordingWaveform(
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<AudioHostWaveform> {
    const response = await this.request({
      type: "recording-waveform",
      start_frame: startFrame,
      end_frame: endFrame,
      max_buckets: maxBuckets
    })
    if (response.result.type !== "recording-waveform" || !response.result.waveform) {
      throw new Error("audio host returned an invalid recording waveform")
    }
    const waveform = response.result.waveform
    return {
      sampleRate: waveform.sample_rate,
      channels: waveform.channels,
      frameCount: waveform.frame_count,
      startFrame: waveform.start_frame,
      endFrame: waveform.end_frame,
      framesPerBucket: waveform.frames_per_bucket,
      bucketCount: waveform.bucket_count,
      peaks: waveform.peaks
    }
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

  async openPluginEditor(instanceId: string): Promise<{
    editorKind: "native" | "generic"
    open: boolean
  }> {
    const response = await this.request({
      type: "open-plugin-editor",
      instance_id: instanceId
    })
    if (response.result.type !== "plugin-editor") {
      throw new Error("audio host returned an invalid plugin editor response")
    }
    return {
      editorKind: response.result.editor_kind === "native" ? "native" : "generic",
      open: response.result.open === true
    }
  }

  async closePluginEditor(instanceId: string): Promise<void> {
    await this.request({
      type: "close-plugin-editor",
      instance_id: instanceId
    })
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
    if (this.stopping && command.type !== "shutdown") {
      return Promise.reject(new Error("audio host is stopping"))
    }
    const pending = this.performRequest(command)
    this.pendingRequests.add(pending)
    void pending.finally(() => this.pendingRequests.delete(pending)).catch(() => {})
    return pending
  }

  private async performRequest(command: Record<string, unknown>): Promise<ControlResponse> {
    const client = this.client
    if (!client) throw new Error("audio host is not running")
    const requestId = this.nextRequestId++
    const payload = Buffer.from(encode({
      version: PROTOCOL_VERSION,
      request_id: requestId,
      command
    }))
    if (payload.length > MAX_MESSAGE_BYTES) {
      throw new Error("audio host message exceeds 64 MiB")
    }
    const response = decode(await client.request(payload)) as ControlResponse
    if (response.request_id !== requestId) {
      throw new Error("audio host returned an out-of-order response")
    }
    if (response.version !== PROTOCOL_VERSION) {
      throw new Error(`unsupported audio host protocol ${response.version}`)
    }
    if (response.result.type === "error") {
      throw new Error(response.result.message ?? "audio host request failed")
    }
    return response
  }

  private handleExit(message: string): void {
    const client = this.client
    if (!client) return
    this.client = null
    this.loadedPlugins.clear()
    try {
      client.close()
    } catch {
      // The helper may already have exited.
    }
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    if (!this.stopping) {
      const suspect = this.readCrashMarker()
      if (suspect) {
        this.recoveryBypassed.add(suspect)
        message = `${message}; recovering with plugin '${suspect}' bypassed`
      } else if ((this.lastGraph?.runtime.plugins.length ?? 0) > 0) {
        for (const plugin of this.lastGraph!.runtime.plugins) {
          this.recoveryBypassed.add(plugin.instance_id)
        }
        message = `${message}; crash marker was inconclusive, recovering with all plugins bypassed`
      }
      this.onFailure(message)
    }
    if (!this.stopping && this.restartBudget > 0) {
      this.restartBudget -= 1
      this.start()
    }
  }

  private readCrashMarker(): string | null {
    try {
      const marker = readFileSync(this.crashMarkerPath)
      if (marker.length < 40) return null
      const magic = marker.readBigUInt64LE(0)
      const generation = marker.readBigUInt64LE(8)
      const pluginIndex = marker.readBigUInt64LE(16)
      const stage = marker.readBigUInt64LE(24)
      const checksum = marker.readBigUInt64LE(32)
      const salt = 0x43524153484d4152n
      if (magic !== 0x5941444157565354n ||
          checksum !== (magic ^ generation ^ pluginIndex ^ stage ^ salt) ||
          stage === 0n ||
          generation !== BigInt(this.lastGraph?.revision ?? -1)) {
        return null
      }
      const plugins = [...(this.lastGraph?.runtime.plugins ?? [])].sort((left, right) =>
        left.channel_index - right.channel_index ||
        Number(left.role !== "instrument") - Number(right.role !== "instrument") ||
        left.slot_order - right.slot_order
      )
      return plugins[Number(pluginIndex)]?.instance_id ?? null
    } catch {
      return null
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    const client = this.client
    if (client) {
      try {
        await this.request({ type: "shutdown" })
      } catch {
        // A helper that has already closed its IPC channel still needs to be reaped below.
      }
    }
    await Promise.allSettled([...this.pendingRequests])
    if (client) {
      if (this.client === client) this.client = null
      client.close()
    }
  }
}
