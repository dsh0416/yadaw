import { readFileSync } from "node:fs"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type {
  AudioBackendDescriptor,
  AudioDeviceList,
  AudioIpcBenchmarkReport,
  AudioIpcBenchmarkScenario,
  AudioIpcPerformanceSnapshot,
  AudioHostRuntimePreferences,
  AudioPreferences,
  AudioRuntimeSnapshot,
  CompiledAudioGraphSnapshot,
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  PluginEditorMode,
  PluginEditorPreference,
  PluginAudioMode,
  PluginInstanceState,
  PluginParameterChange,
  PluginParameterInfo,
  TransportCommand,
  TransportSnapshot
} from "@yadaw/contracts"

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_LOGICAL_REQUEST_BYTES = MAX_MESSAGE_BYTES * 2
const HEARTBEAT_INTERVAL_MS = 250
const HEARTBEAT_TIMEOUT_MS = 2_000

interface ControlResponse {
  request_id: number
  result: {
    type:
      | "pong"
      | "benchmark-echo"
      | "heartbeat"
      | "accepted"
      | "audio-backends"
      | "audio-devices"
      | "audio-runtime"
      | "mixer-snapshot"
      | "compiled-graph-snapshot"
      | "transport-snapshot"
      | "recording-stopped"
      | "recording-waveform"
      | "plugin-loaded"
      | "plugin-parameters"
      | "plugin-state"
      | "graph-accepted"
      | "revision-mismatch"
      | "busy"
      | "plugin-editor"
      | "error"
    message?: string
    callback_generation?: number
    ipc_generation?: number
    tokio_generation?: number
    winit_generation?: number
    transport_state?: string
    runtime_handle?: number
    revision?: number
    current_revision?: number
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
    component_state?: BinaryPayloadWire
    controller_state?: BinaryPayloadWire
    payload?: BinaryPayloadWire
    active_mode?: PluginEditorMode
    open?: boolean
    backends?: AudioBackendDescriptor[]
    devices?: {
      inputs: AudioHostDevice[]
      outputs: AudioHostDevice[]
    }
    runtime?: AudioHostRuntime
    meters?: AudioHostMeter[]
    snapshot?: {
      graph_revision: number
      build_generation: number
      sample_rate: number
      nodes: Array<{
        id: string
        kind: CompiledAudioGraphSnapshot["nodes"][number]["kind"]
        label: string
        channel_id: string | null
        plugin_instance_id: string | null
        signal_width: CompiledAudioGraphSnapshot["nodes"][number]["signalWidth"]
        latency_samples: number
        plugin_state: CompiledAudioGraphSnapshot["nodes"][number]["pluginState"]
      }>
      edges: Array<{
        id: string
        source: string
        target: string
        kind: CompiledAudioGraphSnapshot["edges"][number]["kind"]
        signal_width: CompiledAudioGraphSnapshot["edges"][number]["signalWidth"]
      }>
    } | null
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

type BinaryPayloadWire =
  | { storage: "inline"; bytes: Uint8Array }
  | { storage: "attachment"; index: number; offset: number; length: number }

interface AudioHostTransport {
  state: string
  position_frames: number
  sample_rate: number
}

interface PriorityResponse {
  request_id: number
  result: {
    type: "heartbeat" | "accepted" | "busy" | "error"
    message?: string
    ipc_generation?: number
    tokio_generation?: number
    winit_generation?: number
    callback_generation?: number
    transport_state?: string
    egress_active?: number
    egress_queue_depth?: number
    egress_queue_high_water?: number
    egress_batches?: number
    blocking_jobs?: number
    arena_regions?: number
    arena_capacity_bytes?: number
    arena_used_bytes?: number
    arena_high_water_bytes?: number
    arena_offers?: number
    arena_busy?: number
    arena_quarantined_regions?: number
    arena_copied_bytes?: number
  }
}

type TelemetryWire = [
  epoch: number,
  graphRevision: number,
  callbackGeneration: number,
  transportState: number,
  positionFrames: number,
  sampleRate: number,
  meters: Array<
    [
      runtimeHandle: number,
      preLeft: number,
      preRight: number,
      postLeft: number,
      postRight: number,
      heldLeft: number,
      heldRight: number,
      clipped: boolean
    ]
  >
]

type TransportDiagnosticsWire = [
  nativeBuildFingerprint: string,
  sessionEpoch: string,
  requests: [normalPending: number, priorityPending: number, capacity: number, timeouts: number],
  sharedMemory: [
    outstandingLeases: number,
    outstandingBytes: number,
    maxLeases: number,
    maxBytes: number,
    inlinePackets: number,
    inlineBytes: number,
    sharedPackets: number,
    sharedRegions: number,
    sharedBytes: number
  ],
  eventQueueDepth: number,
  telemetry: [
    epoch: string,
    capacity: number,
    graphRevision: number,
    callbackGeneration: number,
    meterSlots: number,
    fallbackReads: number
  ],
  parameterRing: [
    used: number,
    capacity: number,
    softFull: number,
    hardFull: number,
    boundaryFallbacks: number,
    staleEpoch: number
  ],
  closing: boolean,
  runtimeAndArena: [
    workerThreads: number,
    maxBlockingThreads: number,
    egressConcurrency: number,
    arenaRegions: number,
    arenaCapacityBytes: number,
    arenaUsedBytes: number,
    arenaHighWaterBytes: number,
    arenaOffers: number,
    arenaBusy: number,
    arenaQuarantinedRegions: number,
    copiedBytes: number
  ]
]

function stableRuntimeHandle(namespace: number, id: string): number {
  let value = (2_166_136_261 ^ namespace) >>> 0
  for (const byte of Buffer.from(id)) {
    value ^= byte
    value = Math.imul(value, 16_777_619) >>> 0
  }
  return Math.max(1, value)
}

function inlineBinary(bytes: Uint8Array): BinaryPayloadWire {
  return { storage: "inline", bytes }
}

function binaryBytes(payload?: BinaryPayloadWire): Uint8Array {
  return payload?.storage === "inline" ? payload.bytes : new Uint8Array()
}

function extractLargeAttachments(value: unknown, attachments: Buffer[]): void {
  if (!value || typeof value !== "object") return
  if (
    "storage" in value &&
    "bytes" in value &&
    value.storage === "inline" &&
    value.bytes instanceof Uint8Array &&
    value.bytes.byteLength > 64 * 1024
  ) {
    const payload = value as {
      storage: string
      bytes?: Uint8Array
      index?: number
      offset?: number
      length?: number
    }
    const bytes = Buffer.from(
      payload.bytes!.buffer,
      payload.bytes!.byteOffset,
      payload.bytes!.byteLength
    )
    payload.storage = "attachment"
    payload.index = attachments.length
    payload.offset = 0
    payload.length = bytes.byteLength
    delete payload.bytes
    attachments.push(bytes)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) extractLargeAttachments(child, attachments)
    return
  }
  for (const child of Object.values(value)) extractLargeAttachments(child, attachments)
}

function hydrateAttachments(value: unknown, attachments: readonly Buffer[]): void {
  if (!value || typeof value !== "object") return
  if (
    "storage" in value &&
    "index" in value &&
    value.storage === "attachment" &&
    typeof value.index === "number"
  ) {
    const payload = value as {
      storage: string
      index?: number
      offset?: number
      length?: number
      bytes?: Uint8Array
    }
    const attachment = attachments[payload.index!]
    const offset = payload.offset ?? 0
    const length = payload.length ?? attachment?.byteLength ?? 0
    if (!attachment || offset < 0 || length < 0 || offset + length > attachment.byteLength) {
      throw new Error("audio host returned an invalid attachment reference")
    }
    payload.storage = "inline"
    payload.bytes = attachment.subarray(offset, offset + length)
    delete payload.index
    delete payload.offset
    delete payload.length
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) hydrateAttachments(child, attachments)
    return
  }
  for (const child of Object.values(value)) hydrateAttachments(child, attachments)
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.round(Math.max(0, Math.min(1, fraction)) * (sorted.length - 1))] ?? 0
}

export interface AudioHostGraph {
  sample_rate: number
  channels: Array<{
    id: string
    kind: string
    system_role?: "metronome"
    gain_db: number
    pan: number
    muted: boolean
    soloed: boolean
    output_channel_id?: string
    output_bus?: number
    record_armed: boolean
    input_monitoring: boolean
    input_source?: "hardware" | "bus"
    input_channels: number[]
    hardware_output_channels: number[]
  }>
  sends: Array<{
    id: string
    source_channel_id: string
    target_channel_id?: string
    target_bus?: number
    enabled: boolean
    tap: string
    level_db: number
  }>
  clips: Array<{
    id: string
    channel_id: string
    start_frame: number
    source_offset_frames: number
    length_frames: number
    path: string
  }>
  plugins: Array<{
    instance_id: string
    channel_id: string
    role: string
    slot_order: number
    audio_mode: PluginAudioMode
    enabled: boolean
    latency_samples: number
    tail_samples: number | null
  }>
  midi_clips: Array<{
    id: string
    channel_id: string
    start_tick: number
    source_offset_ticks: number
    length_ticks: number
    notes: {
      storage: "inline"
      notes: Array<{
        start_tick: number
        duration_ticks: number
        channel: number
        key: number
        velocity: number
        release_velocity: number
      }>
    }
    events: {
      storage: "inline"
      events: Array<{
        tick: number
        channel: number | null
        kind: string
        data: BinaryPayloadWire
      }>
    }
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
  peaks: BinaryPayloadWire
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
  private heartbeatInFlight = false
  private stableTimer: NodeJS.Timeout | null = null
  private lastCallbackGeneration: number | null = null
  private callbackStagnantSince = 0
  private lastHeartbeatAt: number | null = null
  private lastHeartbeatGenerations = {
    ipc: 0,
    tokio: 0,
    winit: 0,
    callback: 0
  }
  private lastHostIpcMetrics = {
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
  private restartBudget = 1
  private readonly recoveryBypassed = new Set<string>()
  private stopping = false
  private lastGraph: {
    revision: number
    project: MixerGraphSnapshot
    runtime: AudioHostGraph
  } | null = null
  private publishedGraph: {
    revision: number
    runtime: AudioHostGraph
  } | null = null
  private readonly loadedPlugins = new Map<
    string,
    {
      classId: string
      runtimeHandle: number
      latencySamples: number
      tailSamples: number | null
    }
  >()
  private readonly pendingPreferenceWrites = new Set<Promise<void>>()
  private readonly channelIdsByHandle = new Map<number, string>()
  private readonly coalescedParameters = new Map<
    string,
    {
      targetKind: "plugin" | "mixer-channel" | "mixer-send"
      runtimeHandle: number
      parameterId: number
      normalized: number
    }
  >()
  private parameterFlush: NodeJS.Timeout | null = null
  private lastAudioPreferences: AudioPreferences | null = null
  private audioEngineExpectedRunning = false
  private lastTransport: TransportSnapshot = {
    state: "stopped",
    positionFrames: 0,
    sampleRate: 0
  }
  private recovery: Promise<void> | null = null
  private reconfiguring = false

  constructor(
    private readonly executablePath: string,
    private readonly crashMarkerPath: string,
    private runtimePreferences: AudioHostRuntimePreferences,
    private readonly editorOwnerWindowHandle: Buffer | undefined,
    private readonly onFailure: (message: string) => void,
    private readonly onEditorPreferenceChanged: (
      classId: string,
      preference: PluginEditorPreference
    ) => Promise<void>
  ) {}

  start(restoreGraph = true): void {
    if (this.client || this.stopping) return
    let client: AudioHostIpcClient
    try {
      client = new AudioHostIpcClient(
        this.executablePath,
        this.crashMarkerPath,
        this.runtimePreferences.workerThreads === "auto"
          ? undefined
          : this.runtimePreferences.workerThreads,
        this.runtimePreferences.maxBlockingThreads === "auto"
          ? undefined
          : this.runtimePreferences.maxBlockingThreads,
        this.runtimePreferences.egressConcurrency === "auto"
          ? undefined
          : this.runtimePreferences.egressConcurrency,
        this.editorOwnerWindowHandle
      )
    } catch (error) {
      this.onFailure(`could not start audio host: ${String(error)}`)
      return
    }
    this.client = client
    this.heartbeatInFlight = false
    this.lastCallbackGeneration = null
    this.callbackStagnantSince = 0
    this.lastHeartbeatAt = null
    this.lastHeartbeatGenerations = { ipc: 0, tokio: 0, winit: 0, callback: 0 }
    this.lastHostIpcMetrics = {
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
    this.heartbeat = setInterval(() => {
      if (this.client !== client || this.heartbeatInFlight) return
      this.heartbeatInFlight = true
      void this.performHeartbeat(client)
        .then((response) => {
          if (this.client !== client) return
          if (response.result.type !== "heartbeat") return
          this.captureTransport(client)
          const generation = response.result.callback_generation ?? 0
          this.lastHeartbeatAt = Date.now()
          this.lastHeartbeatGenerations = {
            ipc: response.result.ipc_generation ?? 0,
            tokio: response.result.tokio_generation ?? 0,
            winit: response.result.winit_generation ?? 0,
            callback: generation
          }
          this.lastHostIpcMetrics = {
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
            this.handleExit(client, "audio callback made no progress for 2 seconds")
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.handleExit(client, `heartbeat failed: ${message}`)
        })
        .finally(() => {
          if (this.client === client) this.heartbeatInFlight = false
        })
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
    this.stableTimer = setTimeout(() => {
      if (this.client === client) this.restartBudget = 1
    }, 5_000)
    this.stableTimer.unref()
    if (restoreGraph && this.lastGraph)
      void this.restoreGraph().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.handleExit(client, `could not restore graph: ${message}`)
      })
  }

  private async performHeartbeat(client: AudioHostIpcClient): Promise<PriorityResponse> {
    return this.performPriority({ type: "heartbeat" }, client)
  }

  private async performPriority(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<PriorityResponse> {
    const client = expectedClient ?? this.client
    if (!client) throw new Error("audio host is not running")
    const requestId = this.nextRequestId++
    const payload = Buffer.from(
      encode({
        request_id: requestId,
        command
      })
    )
    const wireResponse = await client.heartbeat(payload)
    const response = decode(wireResponse.body) as PriorityResponse
    if (response.request_id !== requestId) {
      throw new Error("audio host returned an invalid priority response")
    }
    if (response.result.type === "error") {
      throw new Error(response.result.message ?? "audio host heartbeat failed")
    }
    this.drainHostEvents(client)
    return response
  }

  private drainHostEvents(client: AudioHostIpcClient): void {
    const latestPreferences = new Map<string, PluginEditorPreference>()
    for (const event of client.drainEvents()) {
      const decoded = decode(event) as {
        type?: string
        revision?: number
        class_id?: string
        preference?: {
          mode?: string
          zoom_percent?: number
        }
      }
      if (decoded.type === "graph-published" && decoded.revision !== undefined) {
        // The telemetry page carries the same revision. Draining here prevents
        // lifecycle events from accumulating when the renderer is idle.
      } else if (
        decoded.type === "plugin-editor-preference-changed" &&
        typeof decoded.class_id === "string" &&
        (decoded.preference?.mode === "native" || decoded.preference?.mode === "parameters") &&
        Number.isInteger(decoded.preference.zoom_percent) &&
        (decoded.preference.zoom_percent as number) >= 50 &&
        (decoded.preference.zoom_percent as number) <= 400
      ) {
        latestPreferences.set(decoded.class_id, {
          mode: decoded.preference.mode,
          zoomPercent: decoded.preference.zoom_percent as number
        })
      }
    }
    for (const [classId, preference] of latestPreferences) {
      const write = this.onEditorPreferenceChanged(classId, preference).finally(() => {
        this.pendingPreferenceWrites.delete(write)
      })
      this.pendingPreferenceWrites.add(write)
    }
  }

  async loadGraph(
    revision: number,
    project: MixerGraphSnapshot,
    runtime: AudioHostGraph,
    awaitPublication = false
  ): Promise<void> {
    this.lastGraph = {
      revision,
      project: structuredClone(project),
      runtime: structuredClone(runtime)
    }
    await this.restoreGraph()
    if (awaitPublication) {
      const audio = await this.audioEngineSnapshot()
      if (audio.state === "running") await this.waitForGraphPublication(revision)
    }
  }

  private async restoreGraph(immediate = false): Promise<void> {
    const graph = this.lastGraph
    if (!graph) return
    const loaded = await Promise.allSettled(
      graph.project.plugins.map((plugin) =>
        this.loadPluginWithRequest(plugin, graph.project.sampleRate, immediate)
      )
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
    this.channelIdsByHandle.clear()
    for (const channel of runtime.channels) {
      this.channelIdsByHandle.set(stableRuntimeHandle(1, channel.id), channel.id)
    }
    const previous = this.publishedGraph
    const update =
      previous && previous.runtime.sample_rate === runtime.sample_rate
        ? {
            type: "patch",
            base_revision: previous.revision,
            revision: graph.revision,
            ops: this.graphDiff(previous.runtime, runtime)
          }
        : {
            type: "replace",
            revision: graph.revision,
            graph: runtime
          }
    const request = (command: Record<string, unknown>) =>
      immediate ? this.requestImmediately(command) : this.request(command)
    let response = await request({ type: "update-graph", update })
    if (response.result.type === "revision-mismatch") {
      response = await request({
        type: "update-graph",
        update: { type: "replace", revision: graph.revision, graph: runtime }
      })
    }
    if (response.result.type !== "graph-accepted") {
      throw new Error("audio host did not accept the mixer graph")
    }
    this.publishedGraph = {
      revision: graph.revision,
      runtime: structuredClone(runtime)
    }
  }

  private graphDiff(
    previous: AudioHostGraph,
    next: AudioHostGraph
  ): Array<Record<string, unknown>> {
    const operations: Array<Record<string, unknown>> = []
    const diffCollection = <T>(
      before: T[],
      after: T[],
      id: (value: T) => string,
      upsertType: string,
      removeType: string
    ): void => {
      const beforeById = new Map(before.map((value) => [id(value), value]))
      const afterById = new Map(after.map((value) => [id(value), value]))
      for (const [key, value] of afterById) {
        if (JSON.stringify(beforeById.get(key)) !== JSON.stringify(value)) {
          operations.push({ type: upsertType, value })
        }
      }
      for (const key of beforeById.keys()) {
        if (!afterById.has(key)) operations.push({ type: removeType, id: key })
      }
    }
    diffCollection(
      previous.channels,
      next.channels,
      (value) => value.id,
      "upsert-channel",
      "remove-channel"
    )
    diffCollection(previous.sends, next.sends, (value) => value.id, "upsert-send", "remove-send")
    diffCollection(previous.clips, next.clips, (value) => value.id, "upsert-clip", "remove-clip")
    diffCollection(
      previous.plugins,
      next.plugins,
      (value) => value.instance_id,
      "upsert-plugin",
      "remove-plugin"
    )
    diffCollection(
      previous.midi_clips,
      next.midi_clips,
      (value) => value.id,
      "upsert-midi-clip",
      "remove-midi-clip"
    )
    if (
      JSON.stringify(previous.tempo_events) !== JSON.stringify(next.tempo_events) ||
      JSON.stringify(previous.time_signature_events) !== JSON.stringify(next.time_signature_events)
    ) {
      operations.push({
        type: "replace-tempo-map",
        tempo_events: next.tempo_events,
        time_signature_events: next.time_signature_events
      })
    }
    return operations
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
    const runtime = this.runtimeResult(response)
    if (runtime.state === "running") {
      this.lastAudioPreferences = structuredClone(preferences)
      this.audioEngineExpectedRunning = true
    }
    return runtime
  }

  async stopAudioEngine(): Promise<AudioRuntimeSnapshot> {
    // Stopping is user intent. Do not resurrect the engine if the stop reply
    // races with a helper failure after the engine has already shut down.
    this.audioEngineExpectedRunning = false
    const runtime = this.runtimeResult(await this.request({ type: "stop-audio-engine" }))
    return runtime
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
      clockSync:
        value.clock_sync === "shared-device" || value.clock_sync === "adaptive-resampled"
          ? value.clock_sync
          : "inactive",
      bufferFallback: value.buffer_fallback
    }
  }

  async previewMixerParameter(preview: MixerParameterPreview): Promise<void> {
    const client = this.client
    if (!client) throw new Error("audio host is not running")
    const targetKind = preview.target === "channel" ? "mixer-channel" : "mixer-send"
    const parameterId = preview.parameter === "pan" ? 1 : 0
    const normalized =
      preview.parameter === "pan" ? (preview.value + 1) / 2 : (preview.value + 60) / 72
    const result = client.enqueueParameter(
      targetKind,
      stableRuntimeHandle(preview.target === "channel" ? 1 : 2, preview.id),
      parameterId,
      Math.max(0, Math.min(1, normalized)),
      "perform"
    )
    if (result === "soft-full" || result === "full") {
      this.coalesceParameter({
        targetKind,
        runtimeHandle: stableRuntimeHandle(preview.target === "channel" ? 1 : 2, preview.id),
        parameterId,
        normalized
      })
    }
  }

  async mixerSnapshot(): Promise<MixerRuntimeSnapshot> {
    const telemetry = this.readTelemetry()
    return {
      meters: telemetry[6].flatMap((meter) => {
        const channelId = this.channelIdsByHandle.get(meter[0])
        return channelId
          ? [
              {
                channelId,
                preFaderPeak: [meter[1], meter[2]] as [number, number],
                postFaderPeak: [meter[3], meter[4]] as [number, number],
                heldPeak: [meter[5], meter[6]] as [number, number],
                clipped: meter[7]
              }
            ]
          : []
      }),
      capturedAt: Date.now()
    }
  }

  async compiledAudioGraphSnapshot(): Promise<CompiledAudioGraphSnapshot | null> {
    const response = await this.request({ type: "compiled-graph-snapshot" })
    if (response.result.type !== "compiled-graph-snapshot") {
      throw new Error("audio host returned an invalid compiled graph snapshot")
    }
    const value = response.result.snapshot
    if (!value) return null
    return {
      graphRevision: value.graph_revision,
      buildGeneration: value.build_generation,
      sampleRate: value.sample_rate,
      nodes: value.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        channelId: node.channel_id,
        pluginInstanceId: node.plugin_instance_id,
        signalWidth: node.signal_width,
        latencySamples: node.latency_samples,
        pluginState: node.plugin_state
      })),
      edges: value.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        signalWidth: edge.signal_width
      }))
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
    return this.rememberTransport(this.transportResult(response))
  }

  async transportSnapshot(): Promise<TransportSnapshot> {
    const telemetry = this.readTelemetry()
    return this.rememberTransport({
      state: telemetry[3] === 1 ? "playing" : telemetry[3] === 2 ? "recording" : "stopped",
      positionFrames: telemetry[4],
      sampleRate: telemetry[5]
    })
  }

  private readTelemetry(): TelemetryWire {
    const client = this.client
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
        this.executablePath.includes("\\release\\") || this.executablePath.includes("/release/")
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
    const client = this.client
    if (!client) return null
    try {
      const diagnostics = decode(client.transportDiagnostics()) as TransportDiagnosticsWire
      return {
        nativeBuildFingerprint: diagnostics[0],
        sessionEpoch: diagnostics[1],
        heartbeat: {
          ageMs: this.lastHeartbeatAt === null ? null : Date.now() - this.lastHeartbeatAt,
          ipcGeneration: this.lastHeartbeatGenerations.ipc,
          tokioGeneration: this.lastHeartbeatGenerations.tokio,
          winitGeneration: this.lastHeartbeatGenerations.winit,
          callbackGeneration: this.lastHeartbeatGenerations.callback
        },
        requests: {
          normalPending: diagnostics[2][0],
          priorityPending: diagnostics[2][1],
          capacity: diagnostics[2][2],
          timeouts: diagnostics[2][3]
        },
        sharedMemory: {
          outstandingLeases: diagnostics[3][0],
          outstandingBytes: diagnostics[3][1],
          maxLeases: diagnostics[3][2],
          maxBytes: diagnostics[3][3],
          inlinePackets: diagnostics[3][4],
          inlineBytes: diagnostics[3][5],
          sharedPackets: diagnostics[3][6],
          sharedRegions: diagnostics[3][7],
          sharedBytes: diagnostics[3][8],
          arenaRegions: diagnostics[8][3] + this.lastHostIpcMetrics.arenaRegions,
          arenaCapacityBytes: diagnostics[8][4] + this.lastHostIpcMetrics.arenaCapacityBytes,
          arenaUsedBytes: diagnostics[8][5] + this.lastHostIpcMetrics.arenaUsedBytes,
          arenaHighWaterBytes: diagnostics[8][6] + this.lastHostIpcMetrics.arenaHighWaterBytes,
          arenaOffers: diagnostics[8][7] + this.lastHostIpcMetrics.arenaOffers,
          arenaBusy: diagnostics[8][8] + this.lastHostIpcMetrics.arenaBusy,
          arenaQuarantinedRegions:
            diagnostics[8][9] + this.lastHostIpcMetrics.arenaQuarantinedRegions,
          copiedBytes: diagnostics[8][10] + this.lastHostIpcMetrics.arenaCopiedBytes
        },
        runtime: {
          requested: structuredClone(this.runtimePreferences),
          resolved: {
            workerThreads: diagnostics[8][0],
            maxBlockingThreads: diagnostics[8][1],
            egressConcurrency: diagnostics[8][2]
          },
          egressActive: this.lastHostIpcMetrics.egressActive,
          egressQueueDepth: this.lastHostIpcMetrics.egressQueueDepth,
          egressQueueHighWater: this.lastHostIpcMetrics.egressQueueHighWater,
          egressBatches: this.lastHostIpcMetrics.egressBatches,
          blockingJobs: this.lastHostIpcMetrics.blockingJobs
        },
        eventQueueDepth: diagnostics[4],
        telemetry: {
          epoch: diagnostics[5][0],
          capacity: diagnostics[5][1],
          graphRevision: diagnostics[5][2],
          callbackGeneration: diagnostics[5][3],
          meterSlots: diagnostics[5][4],
          fallbackReads: diagnostics[5][5]
        },
        parameterRing: {
          used: diagnostics[6][0],
          capacity: diagnostics[6][1],
          softFull: diagnostics[6][2],
          hardFull: diagnostics[6][3],
          boundaryFallbacks: diagnostics[6][4],
          staleEpoch: diagnostics[6][5]
        }
      }
    } catch {
      return null
    }
  }

  private transportResult(response: ControlResponse): TransportSnapshot {
    const value = response.result.transport
    if (response.result.type !== "transport-snapshot" || !value) {
      throw new Error("audio host returned an invalid transport snapshot")
    }
    return {
      state: value.state === "playing" || value.state === "recording" ? value.state : "stopped",
      positionFrames: value.position_frames,
      sampleRate: value.sample_rate
    }
  }

  private rememberTransport(snapshot: TransportSnapshot): TransportSnapshot {
    this.lastTransport = { ...snapshot }
    return snapshot
  }

  private captureTransport(client: AudioHostIpcClient): void {
    try {
      const telemetry = decode(client.readTelemetry()) as TelemetryWire
      this.rememberTransport({
        state: telemetry[3] === 1 ? "playing" : telemetry[3] === 2 ? "recording" : "stopped",
        positionFrames: telemetry[4],
        sampleRate: telemetry[5]
      })
    } catch {
      // Keep the most recent successfully observed transport intent.
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
      peaks: binaryBytes(waveform.peaks)
    }
  }

  async loadPlugin(
    plugin: PluginInstanceState,
    sampleRate: number
  ): Promise<{
    latencySamples: number
    tailSamples: number | null
  }> {
    return this.loadPluginWithRequest(plugin, sampleRate, false)
  }

  private async loadPluginWithRequest(
    plugin: PluginInstanceState,
    sampleRate: number,
    immediate: boolean
  ): Promise<{
    latencySamples: number
    tailSamples: number | null
  }> {
    const existing = this.loadedPlugins.get(plugin.id)
    if (existing) return existing
    const response = await (
      immediate ? this.requestImmediately.bind(this) : this.request.bind(this)
    )({
      type: "load-plugin",
      instance_id: plugin.id,
      module_path: plugin.descriptor.modulePath,
      class_id: plugin.classId,
      plugin_kind: plugin.descriptor.kind,
      audio_mode: plugin.audioMode,
      sample_rate: sampleRate,
      component_state: inlineBinary(plugin.componentState),
      controller_state: inlineBinary(plugin.controllerState)
    })
    if (response.result.type !== "plugin-loaded") {
      throw new Error("audio host returned an invalid plugin load response")
    }
    const status = {
      classId: plugin.classId,
      runtimeHandle: response.result.runtime_handle ?? 0,
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

  async openPluginEditor(
    instanceId: string,
    preference: PluginEditorPreference
  ): Promise<{
    editorMode: PluginEditorMode
    open: boolean
  }> {
    const response = await this.request({
      type: "open-plugin-editor",
      instance_id: instanceId,
      preference: {
        mode: preference.mode,
        zoom_percent: preference.zoomPercent
      }
    })
    if (response.result.type !== "plugin-editor") {
      throw new Error("audio host returned an invalid plugin editor response")
    }
    return {
      editorMode: response.result.active_mode === "native" ? "native" : "parameters",
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
    const client = this.client
    const plugin = this.loadedPlugins.get(change.instanceId)
    if (!client || !plugin?.runtimeHandle) {
      await this.request({
        type: "set-plugin-parameter",
        instance_id: change.instanceId,
        parameter_id: change.parameterId,
        normalized: change.normalized,
        gesture: change.gesture
      })
      return
    }
    const result = client.enqueueParameter(
      "plugin",
      plugin.runtimeHandle,
      change.parameterId,
      change.normalized,
      change.gesture
    )
    if ((result === "soft-full" || result === "full") && change.gesture === "perform") {
      this.coalesceParameter({
        targetKind: "plugin",
        runtimeHandle: plugin.runtimeHandle,
        parameterId: change.parameterId,
        normalized: change.normalized
      })
    }
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
      componentState: binaryBytes(response.result.component_state),
      controllerState: binaryBytes(response.result.controller_state)
    }
  }

  private coalesceParameter(value: {
    targetKind: "plugin" | "mixer-channel" | "mixer-send"
    runtimeHandle: number
    parameterId: number
    normalized: number
  }): void {
    const key = `${value.targetKind}:${value.runtimeHandle}:${value.parameterId}`
    this.coalescedParameters.set(key, value)
    if (this.parameterFlush) return
    this.parameterFlush = setTimeout(() => {
      this.parameterFlush = null
      const client = this.client
      if (!client) return
      const pending = [...this.coalescedParameters.entries()]
      this.coalescedParameters.clear()
      for (const [pendingKey, command] of pending) {
        const result = client.enqueueParameter(
          command.targetKind,
          command.runtimeHandle,
          command.parameterId,
          Math.max(0, Math.min(1, command.normalized)),
          "perform"
        )
        if (result === "soft-full" || result === "full") {
          this.coalescedParameters.set(pendingKey, command)
        }
      }
      if (this.coalescedParameters.size > 0) {
        this.coalesceParameter(this.coalescedParameters.values().next().value!)
      }
    }, 4)
    this.parameterFlush.unref()
  }

  private request(command: Record<string, unknown>): Promise<ControlResponse> {
    if (this.stopping && command.type !== "shutdown") {
      return Promise.reject(new Error("audio host is stopping"))
    }
    const recovery = this.recovery
    if (recovery && command.type !== "shutdown") {
      return recovery.then(() => this.requestImmediately(command))
    }
    return this.requestImmediately(command)
  }

  private requestImmediately(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<ControlResponse> {
    const pending = this.performRequest(command, expectedClient)
    this.pendingRequests.add(pending)
    void pending.finally(() => this.pendingRequests.delete(pending)).catch(() => {})
    return pending
  }

  private async performRequest(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<ControlResponse> {
    const client = expectedClient ?? this.client
    if (!client) throw new Error("audio host is not running")
    const requestId = this.nextRequestId++
    const request = {
      request_id: requestId,
      command
    }
    const attachments: Buffer[] = []
    extractLargeAttachments(request, attachments)
    const payload = Buffer.from(encode(request))
    if (payload.length > MAX_LOGICAL_REQUEST_BYTES) {
      throw new Error("audio host logical request exceeds 128 MiB")
    }
    const wireResponse = await client.request(payload, attachments)
    const response = decode(wireResponse.body) as ControlResponse
    hydrateAttachments(response, wireResponse.attachments)
    if (response.request_id !== requestId) {
      throw new Error("audio host returned an out-of-order response")
    }
    if (response.result.type === "error") {
      throw new Error(response.result.message ?? "audio host request failed")
    }
    return response
  }

  private handleExit(client: AudioHostIpcClient, message: string): void {
    // A timed-out request from an older helper may reject after its replacement
    // is already running. It must never be allowed to tear down that new client.
    if (this.client !== client) return
    this.captureTransport(client)
    this.client = null
    this.heartbeatInFlight = false
    this.loadedPlugins.clear()
    this.publishedGraph = null
    this.channelIdsByHandle.clear()
    this.coalescedParameters.clear()
    if (this.parameterFlush) clearTimeout(this.parameterFlush)
    this.parameterFlush = null
    try {
      client.close()
    } catch {
      // The helper may already have exited.
    }
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    if (this.stopping) return
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
    if (this.reconfiguring || this.recovery || this.restartBudget <= 0) return

    this.restartBudget -= 1
    const audioPreferences = this.lastAudioPreferences
      ? structuredClone(this.lastAudioPreferences)
      : null
    const transport = { ...this.lastTransport }
    const recovery = this.recoverAfterFailure(
      audioPreferences,
      transport,
      this.audioEngineExpectedRunning
    )
    this.recovery = recovery
    void recovery
      .catch((error: unknown) => {
        if (!this.stopping) this.onFailure(`audio helper recovery failed: ${String(error)}`)
      })
      .finally(() => {
        if (this.recovery === recovery) this.recovery = null
      })
  }

  private async recoverAfterFailure(
    audioPreferences: AudioPreferences | null,
    transport: TransportSnapshot,
    audioEngineWasRunning: boolean
  ): Promise<void> {
    this.start(false)
    const client = this.client
    if (!client) throw new Error("Audio helper did not restart")

    this.runtimeResult(await this.requestImmediately({ type: "audio-engine-snapshot" }, client))
    const audioEngineRestored = audioEngineWasRunning && audioPreferences !== null
    if (audioEngineRestored) {
      const runtime = this.runtimeResult(
        await this.requestImmediately(
          {
            type: "start-audio-engine",
            config: {
              backend: audioPreferences.backend,
              input_device_id: audioPreferences.inputDeviceId,
              output_device_id: audioPreferences.outputDeviceId,
              buffer_size: audioPreferences.bufferSize
            }
          },
          client
        )
      )
      if (runtime.state !== "running") {
        throw new Error("Audio engine did not return to running state")
      }
    }

    await this.restoreGraph(true)
    if (!audioEngineRestored) return
    if (this.lastGraph) await this.waitForGraphPublication(this.lastGraph.revision)

    const seek = await this.requestImmediately(
      {
        type: "transport",
        command: { kind: "seek", position_frames: transport.positionFrames }
      },
      client
    )
    this.rememberTransport(this.transportResult(seek))
    if (transport.state === "playing") {
      const play = await this.requestImmediately(
        {
          type: "transport",
          command: { kind: "play", position_frames: null }
        },
        client
      )
      this.rememberTransport(this.transportResult(play))
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
      if (
        magic !== 0x5941444157565354n ||
        checksum !== (magic ^ generation ^ pluginIndex ^ stage ^ salt) ||
        stage === 0n ||
        generation !== BigInt(this.lastGraph?.revision ?? -1)
      ) {
        return null
      }
      const plugins = [...(this.lastGraph?.runtime.plugins ?? [])].sort(
        (left, right) =>
          left.channel_id.localeCompare(right.channel_id) ||
          Number(left.role !== "instrument") - Number(right.role !== "instrument") ||
          left.slot_order - right.slot_order
      )
      return plugins[Number(pluginIndex)]?.instance_id ?? null
    } catch {
      return null
    }
  }

  get configurationRestarting(): boolean {
    return this.reconfiguring || this.recovery !== null
  }

  async configureRuntime(preferences: AudioHostRuntimePreferences): Promise<void> {
    if (this.reconfiguring || this.recovery || this.stopping) {
      throw new Error("Audio host runtime configuration is busy")
    }
    this.reconfiguring = true
    const previousPreferences = structuredClone(this.runtimePreferences)
    const transport = await this.transportSnapshot()
    const audioRuntime = await this.audioEngineSnapshot()
    const audioEngineWasRunning = audioRuntime.state === "running"
    const audioPreferences = this.lastAudioPreferences
      ? structuredClone(this.lastAudioPreferences)
      : null
    try {
      await this.capturePluginStatesForRestart()
      if (transport.state !== "stopped") await this.transport({ type: "pause" })
      for (const instanceId of this.loadedPlugins.keys()) {
        try {
          await this.closePluginEditor(instanceId)
        } catch {
          // An editor may already have been closed by the plug-in.
        }
      }
      if (audioEngineWasRunning) await this.stopAudioEngine()
      await this.shutdownCurrentClient()
      this.runtimePreferences = structuredClone(preferences)
      await this.restartAfterConfiguration(audioPreferences, transport, audioEngineWasRunning)
    } catch (error) {
      try {
        await this.shutdownCurrentClient()
        this.runtimePreferences = previousPreferences
        await this.restartAfterConfiguration(audioPreferences, transport, audioEngineWasRunning)
      } catch (rollbackError) {
        this.onFailure(
          `audio runtime configuration and rollback failed: ${String(error)}; ${String(rollbackError)}`
        )
      }
      throw error
    } finally {
      this.reconfiguring = false
    }
  }

  private async capturePluginStatesForRestart(): Promise<void> {
    const graph = this.lastGraph
    if (!graph) return
    for (const plugin of graph.project.plugins) {
      if (!this.loadedPlugins.has(plugin.id)) continue
      try {
        const state = await this.savePluginState(plugin.id)
        plugin.componentState = state.componentState
        plugin.controllerState = state.controllerState
      } catch (error) {
        console.warn(`Could not capture VST3 state for runtime restart (${plugin.id})`, error)
      }
    }
  }

  private async restartAfterConfiguration(
    audioPreferences: AudioPreferences | null,
    transport: TransportSnapshot,
    audioEngineWasRunning: boolean
  ): Promise<void> {
    this.start(false)
    if (!this.client) throw new Error("Audio helper did not restart")
    await this.audioEngineSnapshot()
    const audioEngineRestored = audioEngineWasRunning && audioPreferences !== null
    if (audioEngineRestored) await this.startAudioEngine(audioPreferences)
    await this.restoreGraph()
    if (audioEngineRestored && this.lastGraph) {
      await this.waitForGraphPublication(this.lastGraph.revision)
    }
    if (audioEngineRestored) {
      await this.transport({ type: "seek", positionFrames: transport.positionFrames })
      if (transport.state === "playing") await this.transport({ type: "play" })
    }
  }

  private async waitForGraphPublication(revision: number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const telemetry = this.readTelemetry()
      if (telemetry[1] === revision) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Audio graph revision ${revision} was not published after restart`)
  }

  private async shutdownCurrentClient(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.heartbeatInFlight = false
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    if (this.parameterFlush) clearTimeout(this.parameterFlush)
    this.parameterFlush = null
    const client = this.client
    if (!client) return
    try {
      await this.performPriority({ type: "shutdown" }, client)
    } catch {
      // Closing the client below also reaps a helper that exited early.
    }
    this.drainHostEvents(client)
    if (this.client === client) this.client = null
    client.close()
    await Promise.allSettled([...this.pendingRequests])
    await Promise.allSettled([...this.pendingPreferenceWrites])
    this.loadedPlugins.clear()
    this.publishedGraph = null
    this.channelIdsByHandle.clear()
    this.coalescedParameters.clear()
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.shutdownCurrentClient()
  }
}
