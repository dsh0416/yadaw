import type {
  AudioBackendDescriptor,
  CompiledAudioGraphSnapshot,
  PluginEditorMode,
  PluginAudioMode
} from "@yadaw/contracts"
import type { AudioEngineRef, ProjectGraphRef, RpcError, RpcResult } from "@yadaw/contracts"

export interface GraphCandidateSnapshot {
  operationId: string
  projectGraph: ProjectGraphRef
  baseRevision: number
  graphRevision: number
}

export interface GraphOperationSnapshot {
  operationId: string
  outcome: "committed" | "not-committed" | "quarantined"
  graphRevision: number
}

export interface GraphDeploymentSnapshot {
  helperEpoch: string
  engine: AudioEngineRef
  status: "empty" | "prepared" | "active" | "degraded"
  committedProjectGraph: ProjectGraphRef | null
  committedRevision: number
  observedRevision: number
  candidate: GraphCandidateSnapshot | null
  lastOperation: GraphOperationSnapshot | null
}

export type GraphTransactionValue =
  | { type: "prepared"; snapshot: GraphDeploymentSnapshot }
  | { type: "activated"; snapshot: GraphDeploymentSnapshot }
  | {
      type: "aborted"
      operationId: string
      existed: boolean
      snapshot: GraphDeploymentSnapshot
    }
  | { type: "snapshot"; snapshot: GraphDeploymentSnapshot }

export interface ControlResponse {
  request_id: number
  result: {
    type:
      | "pong"
      | "benchmark-echo"
      | "audio-benchmark"
      | "heartbeat"
      | "accepted"
      | "audio-backends"
      | "audio-devices"
      | "audio-runtime"
      | "round-trip-latency-measurement"
      | "mixer-snapshot"
      | "compiled-graph-snapshot"
      | "transport-snapshot"
      | "midi-input-snapshot"
      | "recording-stopped"
      | "midi-recording-stopped"
      | "recording-waveform"
      | "plugin-loaded"
      | "plugin-parameters"
      | "plugin-state"
      | "graph-accepted"
      | "graph-transaction"
      | "revision-mismatch"
      | "busy"
      | "plugin-editor"
      | "error"
    error?: RpcError
    result?: RpcResult<GraphTransactionValue>
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
      formatted?: string
      flags: number
    }>
    component_state?: BinaryPayloadWire
    controller_state?: BinaryPayloadWire
    ara_document_state?: BinaryPayloadWire
    payload?: BinaryPayloadWire
    report?: AudioHostBenchmarkReport
    active_mode?: PluginEditorMode
    open?: boolean
    backends?: AudioBackendDescriptor[]
    devices?: {
      inputs: AudioHostDevice[]
      outputs: AudioHostDevice[]
    }
    runtime?: AudioHostRuntime
    measurement?: AudioHostRoundTripLatencyMeasurement
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
        target_input_bus_index?: number
      }>
    } | null
    transport?: AudioHostTransport
    midi_input?: AudioHostMidiInputSnapshot
    recording?: AudioHostRecordingResultWire
    midi_recording?: AudioHostMidiRecordingResultWire
    waveform?: AudioHostWaveformWire
  }
}

export interface AudioHostDevice {
  id: string
  name: string
  is_default: boolean
  default_sample_rate: number | null
  min_buffer_size: number | null
  max_buffer_size: number | null
  channel_count: number | null
}

export interface AudioHostRuntime {
  state: string
  requested_buffer_size: number | null
  sample_rate: number | null
  input_sample_rate: number | null
  output_sample_rate: number | null
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

export interface AudioHostRoundTripLatencyMeasurement {
  status: string
  input_channel: number | null
  output_channel: number | null
  measured_round_trip_latency_ms: number | null
  failure: string | null
}

export interface AudioHostMeter {
  channel_id: string
  pre_left: number
  pre_right: number
  post_left: number
  post_right: number
  held_left: number
  held_right: number
  clipped: boolean
}

export interface AudioHostBenchmarkReport {
  duration_ms: number
  overall_realtime_factor: number
  worst_p99_deadline_utilization_percent: number
  scenarios: Array<{
    id: string
    label: string
    description: string
    sample_rate: number
    block_size: number
    tracks: number
    buses: number
    sends: number
    plugins: number
    elapsed_ms: number
    audio_duration_ms: number
    average_block_ms: number
    p95_block_ms: number
    p99_block_ms: number
    max_block_ms: number
    buffer_budget_ms: number
    p99_deadline_utilization_percent: number
    deadline_misses: number
    measured_blocks: number
    realtime_factor: number
  }>
}

export type BinaryPayloadWire =
  | { storage: "inline"; bytes: Uint8Array }
  | { storage: "attachment"; index: number; offset: number; length: number }

export interface AudioHostTransport {
  state: string
  position_frames: number
  position_ticks: number
  sample_rate: number
  effective_bpm: number | null
  clock_source: string
  waiting_for: string | null
  loop_enabled: boolean
  loop_start_tick: number | null
  loop_end_tick: number | null
}

export interface AudioHostMidiInputRoute {
  port_id: string | null
  port_name: string | null
  channel: number | null
}

export interface AudioHostMidiInputSnapshot {
  ports: Array<{ id: string; name: string; connected: boolean }>
  sync: {
    state: string
    source_port_id: string | null
    source_port_name: string | null
    effective_bpm: number | null
    jitter_microseconds: number
    last_clock_age_ms: number | null
    dropped_events: number
    ignored_system_messages: number
    error: string | null
  }
  control_events: Array<{
    generation: number
    timestamp_microseconds: number
    port_id: string
    port_name: string
    channel: number
    type: "note" | "control-change"
    number: number
    value: number
  }>
  recording_preview?: {
    position_tick: number
    takes: Array<{
      clip_id: string
      track_id: string
      notes: Array<{
        id: number
        start_tick: number
        end_tick: number
        channel: number
        key: number
        velocity: number
        active: boolean
      }>
    }>
  }
  captured_at: number
}

export interface PriorityResponse {
  request_id: number
  result: {
    type: "heartbeat" | "accepted" | "busy" | "error"
    error?: RpcError
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

export type TelemetryWire = [
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

export type TransportDiagnosticsWire = [
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
  ],
  persistentPages: [active: boolean, activationFailures: number]
]

export function stableRuntimeHandle(namespace: number, id: string): number {
  let value = (2_166_136_261 ^ namespace) >>> 0
  for (const byte of Buffer.from(id)) {
    value ^= byte
    value = Math.imul(value, 16_777_619) >>> 0
  }
  return Math.max(1, value)
}

export function inlineBinary(bytes: Uint8Array): BinaryPayloadWire {
  return { storage: "inline", bytes }
}

export function binaryBytes(payload?: BinaryPayloadWire): Uint8Array {
  return payload?.storage === "inline" ? payload.bytes : new Uint8Array()
}

export function extractLargeAttachments(value: unknown, attachments: Buffer[]): void {
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

export function hydrateAttachments(value: unknown, attachments: readonly Buffer[]): void {
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

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.round(Math.max(0, Math.min(1, fraction)) * (sorted.length - 1))] ?? 0
}

export interface AudioHostGraph {
  sample_rate: number
  channels: Array<{
    id: string
    name: string
    color: string
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
    midi_input_port_id?: string
    midi_input_port_name?: string
    midi_input_channel?: number
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
    fade_in_frames: number
    fade_out_frames: number
    path: string
  }>
  plugins: Array<{
    instance_id: string
    channel_id: string
    role: string
    slot_order: number
    audio_mode: PluginAudioMode
    enabled: boolean
    aux_input_buses: Array<{
      input_bus_index: number
      name: string
      channels: number
      source_channel_id?: string
    }>
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

export interface AudioHostRecordingResultWire {
  path: string
  sample_rate: number
  channels: number
  frame_count: number
  dropout_frames: number
}

export interface AudioHostMidiRecordingTakeConfig {
  path: string
  sourceId: string
  clipId: string
  trackId: string
  portId: string | null
  channel: number | null
}

export interface AudioHostMidiRecordingConfig {
  takes: AudioHostMidiRecordingTakeConfig[]
}

export interface AudioHostMidiRecordingTakeResultWire {
  path: string
  source_id: string
  clip_id: string
  track_id: string
  event_count: number
  dropped_events: number
}

export interface AudioHostMidiRecordingResultWire {
  takes: AudioHostMidiRecordingTakeResultWire[]
}

export interface AudioHostMidiRecordingTakeResult {
  path: string
  sourceId: string
  clipId: string
  trackId: string
  eventCount: number
  droppedEvents: number
}

export interface AudioHostMidiRecordingResult {
  takes: AudioHostMidiRecordingTakeResult[]
}

export interface AudioHostWaveformWire {
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
