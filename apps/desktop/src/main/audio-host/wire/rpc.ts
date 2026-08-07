import type {
  AudioBackendDescriptor,
  AudioEngineRef,
  CompiledAudioGraphSnapshot,
  PluginEditorMode,
  ProjectGraphRef,
  RpcError,
  RpcResult
} from "@heron/contracts"
import type {
  AudioHostApplicationCaptureSnapshot,
  AudioHostApplicationCaptureTarget,
  AudioHostBenchmarkReport,
  AudioHostDevice,
  AudioHostMeter,
  AudioHostRoundTripLatencyMeasurement,
  AudioHostRuntime,
  AudioHostTransport
} from "./audio"
import type { BinaryPayloadWire } from "./binary"
import type { AudioHostMidiInputSnapshot } from "./midi"
import type { AudioHostBounceStatus } from "./bounce"
import type {
  AudioHostMidiRecordingResultWire,
  AudioHostRecordingResultWire,
  AudioHostWaveformWire
} from "./recording"

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
      | "application-capture-targets"
      | "application-captures"
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
      | "plugin-editor-toolbar"
      | "bounce-output"
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
      parameter_key: string
      runtime_token: number
      title: string
      units: string
      step_count: number
      default_normalized: number
      normalized: number
      min_value: number
      max_value: number
      default_value: number
      value: number
      normalized_value: number
      module_path: string
      read_only: boolean
      hidden: boolean
      stepped: boolean
      automatable: boolean
      bypass: boolean
      formatted?: string
    }>
    payload?: BinaryPayloadWire
    report?: AudioHostBenchmarkReport
    active_mode?: PluginEditorMode
    open?: boolean
    state?:
      | {
          version: number
          chunks: Array<{ key: string; bytes: BinaryPayloadWire }>
        }
      | {
          active_mode: PluginEditorMode
          zoom_percent: number
          compare_slot: "a" | "b"
          can_compare: boolean
          can_paste: boolean
          can_undo: boolean
          can_redo: boolean
          sidechain_buses: Array<{
            input_port_key: string
            name: string
            source_channel_id: string | null
          }>
          sidechain_sources: Array<{
            id: string
            name: string
            kind: "audio" | "instrument" | "aux"
          }>
          sidechain_pending: boolean
        }
    backends?: AudioBackendDescriptor[]
    devices?: { inputs: AudioHostDevice[]; outputs: AudioHostDevice[] }
    targets?: AudioHostApplicationCaptureTarget[]
    captures?: AudioHostApplicationCaptureSnapshot[]
    runtime?: AudioHostRuntime
    measurement?: AudioHostRoundTripLatencyMeasurement
    meters?: AudioHostMeter[]
    snapshot?: {
      graph_revision: number
      build_generation: number
      sample_rate: number
      low_latency_unavoidable_latency_samples?: number
      has_low_latency_monitoring_path?: boolean
      nodes: Array<{
        id: string
        kind: CompiledAudioGraphSnapshot["nodes"][number]["kind"]
        label: string
        channel_id: string | null
        plugin_instance_id: string | null
        signal_width: CompiledAudioGraphSnapshot["nodes"][number]["signalWidth"]
        latency_samples: number
        plugin_state: CompiledAudioGraphSnapshot["nodes"][number]["pluginState"]
        latency_sensitive: boolean
        low_latency_bypassed: boolean
      }>
      edges: Array<{
        id: string
        source: string
        target: string
        kind: CompiledAudioGraphSnapshot["edges"][number]["kind"]
        signal_width: CompiledAudioGraphSnapshot["edges"][number]["signalWidth"]
        target_input_port_key?: string
      }>
    } | null
    transport?: AudioHostTransport
    midi_input?: AudioHostMidiInputSnapshot
    recording?: AudioHostRecordingResultWire
    midi_recording?: AudioHostMidiRecordingResultWire
    waveform?: AudioHostWaveformWire
    status?: AudioHostBounceStatus
  }
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
