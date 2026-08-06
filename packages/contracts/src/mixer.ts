import type {
  KeySignatureEventState,
  MidiClipRangePatch,
  MidiClipState,
  MidiInputRoute,
  MidiNotePatch,
  MidiNoteState,
  MidiSourceState,
  TempoMapSnapshot
} from "./midi"
import type { PluginInstanceRole, PluginInstanceState } from "./plugins"

export const MIXER_BUS_COUNT = 256
export const DEFAULT_PROJECT_END_TICK = 61_440

export type MixerChannelKind = "audio" | "instrument" | "aux" | "master" | "output"
export type MixerSystemRole = "metronome"
export type MixerInputSource = "hardware" | "bus" | "application"
export type MixerInputFormat = "mono" | "stereo"
export type MixerSendTap = "pre" | "post" | "post-pan"

export interface MixerChannelState {
  id: string
  kind: MixerChannelKind
  systemRole: MixerSystemRole | null
  name: string
  color: string
  sortOrder: number
  inputSource: MixerInputSource | null
  inputFormat: MixerInputFormat | null
  /** Logical identity of the application captured by an application input. */
  applicationCapture?: ApplicationCaptureTarget | null
  /** Present only for ordinary Instrument tracks. */
  midiInput?: MidiInputRoute | null
  gainDb: number
  pan: number
  muted: boolean
  soloed: boolean
  outputChannelId: string | null
  outputBus?: number | null
  recordArmed: boolean
  inputMonitoring: boolean
  inputChannels: number[]
  hardwareOutputChannels: number[]
}

export interface ApplicationCaptureTarget {
  platform: "windows"
  executablePath: string
  executableName: string
  includeProcessTree: boolean
}

export interface MixerBusState {
  channel: number
  name: string
}

export type MixerRouteTarget = { kind: "bus"; bus: number } | { kind: "output"; channelId: string }

export interface TrackState {
  id: string
  channelId: string
  sortOrder: number
  notes?: string
}

export type TrackPatch = Partial<Pick<TrackState, "sortOrder" | "notes">>

export interface AudioClipState {
  id: string
  assetId: string
  trackId: string
  name: string
  startFrame: number
  sourceOffsetFrames: number
  lengthFrames: number
  sourceLengthFrames: number
  fadeInFrames: number
  fadeOutFrames: number
  assetSampleRate: number
  assetChannels: number
}

export type AudioClipPatch = Partial<
  Pick<
    AudioClipState,
    "startFrame" | "sourceOffsetFrames" | "lengthFrames" | "fadeInFrames" | "fadeOutFrames"
  >
>

export interface MixerSendState {
  id: string
  sourceChannelId: string
  targetChannelId?: string | null
  targetBus: number | null
  sortOrder: number
  enabled: boolean
  tap: MixerSendTap
  levelDb: number
}

export interface ProjectGraphSnapshot {
  sampleRate: number
  projectNotes?: string
  projectEndTick?: number
  tracks: TrackState[]
  channels: MixerChannelState[]
  audioClips: AudioClipState[]
  sends: MixerSendState[]
  plugins: PluginInstanceState[]
  midiClips: MidiClipState[]
  tempoMap: TempoMapSnapshot
  keySignatureEvents: KeySignatureEventState[]
}

export type MixerChannelPatch = Partial<
  Pick<
    MixerChannelState,
    | "name"
    | "color"
    | "sortOrder"
    | "inputSource"
    | "inputFormat"
    | "applicationCapture"
    | "midiInput"
    | "gainDb"
    | "pan"
    | "muted"
    | "soloed"
    | "outputChannelId"
    | "outputBus"
    | "recordArmed"
    | "inputMonitoring"
    | "inputChannels"
    | "hardwareOutputChannels"
  >
>

export type CompiledAudioGraphSignalWidth = "mono" | "stereo"
export type CompiledAudioGraphPluginState = "active" | "bypassed" | "unavailable"
export type CompiledAudioGraphNodeKind =
  | "hardware-input"
  | "application-input"
  | "bus-input"
  | "timeline-input"
  | "instrument-input"
  | "channel"
  | "effect"
  | "send"
  | "master"
  | "hardware-output"
  | "width-adapter"
  | "pdc-delay"

export type CompiledAudioGraphEdgeKind =
  | "signal"
  | "main-route"
  | "send-route"
  | "sidechain-route"
  | "hardware-route"

export interface CompiledAudioGraphNode {
  id: string
  kind: CompiledAudioGraphNodeKind
  label: string
  channelId: string | null
  pluginInstanceId: string | null
  signalWidth: CompiledAudioGraphSignalWidth
  latencySamples: number
  pluginState: CompiledAudioGraphPluginState | null
  latencySensitive?: boolean
  lowLatencyBypassed?: boolean
}

export interface CompiledAudioGraphEdge {
  id: string
  source: string
  target: string
  kind: CompiledAudioGraphEdgeKind
  signalWidth: CompiledAudioGraphSignalWidth
  /** Stable plug-in input port key for side-chain edges. */
  targetInputPortKey?: string
}

export interface CompiledAudioGraphSnapshot {
  graphRevision: number
  buildGeneration: number
  sampleRate: number
  lowLatencyUnavoidableLatencySamples?: number
  hasLowLatencyMonitoringPath?: boolean
  nodes: CompiledAudioGraphNode[]
  edges: CompiledAudioGraphEdge[]
}

export interface LowLatencyModeSnapshot {
  enabled: boolean
  targetOutputChannelId: string | null
  pluginBudgetMs: number
  effectiveBudgetSamples: number
  bypassedPluginInstanceIds: string[]
  unavoidableLatencySamples: number
  hasMonitoringPath: boolean
}

export interface LowLatencyModeConfiguration {
  enabled?: boolean
  targetOutputChannelId?: string
  pluginBudgetMs?: number
}

export type MixerSendPatch = Partial<
  Pick<
    MixerSendState,
    "targetChannelId" | "targetBus" | "sortOrder" | "enabled" | "tap" | "levelDb"
  >
>

export type PluginInstancePatch = Partial<
  Pick<PluginInstanceState, "slotOrder" | "enabled" | "descriptor" | "sidechainInputs" | "state">
>

export type ProjectCommand =
  | { type: "update-project-notes"; notes: string }
  | { type: "update-project-end"; endTick: number }
  | { type: "create-track"; track: TrackState; channel: MixerChannelState }
  | { type: "delete-track"; trackId: string }
  | { type: "update-track"; trackId: string; patch: TrackPatch }
  | { type: "create-channel"; channel: MixerChannelState }
  | { type: "delete-channel"; channelId: string }
  | { type: "update-channel"; channelId: string; patch: MixerChannelPatch }
  | { type: "create-send"; send: MixerSendState }
  | { type: "delete-send"; sendId: string }
  | { type: "update-send"; sendId: string; patch: MixerSendPatch }
  | { type: "create-audio-clip"; clip: AudioClipState }
  | { type: "delete-audio-clip"; clipId: string }
  | { type: "move-audio-clip"; clipId: string; trackId: string; startFrame: number }
  | { type: "update-audio-clip"; clipId: string; patch: AudioClipPatch }
  | { type: "create-plugin"; plugin: PluginInstanceState }
  | { type: "delete-plugin"; pluginId: string }
  | { type: "update-plugin"; pluginId: string; patch: PluginInstancePatch }
  | {
      type: "move-plugin"
      pluginId: string
      channelId: string
      role: PluginInstanceRole
      slotOrder: number
    }
  | { type: "replace-plugin"; pluginId: string; plugin: PluginInstanceState }
  | { type: "create-midi-source"; source: MidiSourceState }
  | { type: "delete-midi-source"; source: MidiSourceState }
  | { type: "create-midi-clip"; clip: MidiClipState }
  | { type: "delete-midi-clip"; clipId: string }
  | { type: "move-midi-clip"; clipId: string; trackId: string; startTick: number }
  | { type: "update-midi-clip-range"; clipId: string; patch: MidiClipRangePatch }
  | { type: "create-midi-notes"; clipId: string; notes: MidiNoteState[] }
  | { type: "delete-midi-notes"; clipId: string; noteIds: string[] }
  | {
      type: "update-midi-notes"
      clipId: string
      updates: Array<{ noteId: string; patch: MidiNotePatch }>
    }
  | { type: "rebase-midi-clip-content"; clipId: string; deltaTicks: number }
  | { type: "replace-tempo-map"; tempoMap: TempoMapSnapshot }
  | { type: "replace-key-signature-map"; events: KeySignatureEventState[] }
  | { type: "batch"; commands: ProjectCommand[] }

export interface ProjectCommandResult {
  graph: ProjectGraphSnapshot
  inverse: ProjectCommand
}

export type MixerParameterPreview =
  | {
      target: "channel"
      id: string
      parameter: "gainDb" | "pan"
      value: number
    }
  | {
      target: "send"
      id: string
      parameter: "levelDb"
      value: number
    }
  | {
      target: "plugin"
      id: string
      parameter: "enabled"
      value: number
    }

export interface MixerChannelMeter {
  channelId: string
  preFaderPeak: [number, number]
  postFaderPeak: [number, number]
  heldPeak: [number, number]
  clipped: boolean
}

export interface MixerRuntimeSnapshot {
  meters: MixerChannelMeter[]
  capturedAt: number
}

export type TransportState = "stopped" | "waiting" | "counting-in" | "playing" | "recording"
export type TransportWaitingAction = "play" | "record"
export type TransportClockSource = "internal" | "external"
export interface TransportLoopRange {
  startTick: number
  endTick: number
}
export interface TransportSnapshot {
  state: TransportState
  positionFrames: number
  positionTicks?: number
  sampleRate: number
  effectiveBpm?: number
  clockSource?: TransportClockSource
  waitingFor?: TransportWaitingAction | null
  loopEnabled: boolean
  loopRange: TransportLoopRange | null
}

export type TransportCommand =
  | { type: "play" }
  | { type: "record" }
  | { type: "pause" }
  | { type: "record-count-in" }
  | { type: "stop" }
  | { type: "seek"; positionFrames: number }
  | { type: "set-loop"; enabled: boolean; range: TransportLoopRange | null }
