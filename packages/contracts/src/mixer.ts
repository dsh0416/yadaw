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

export type MixerChannelKind = "audio" | "instrument" | "aux" | "master" | "output"
export type MixerSystemRole = "metronome"
export type MixerInputSource = "hardware" | "bus"
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

export interface MixerBusState {
  channel: number
  name: string
}

export type MixerRouteTarget = { kind: "bus"; bus: number } | { kind: "output"; channelId: string }

export interface TimelineClipState {
  id: string
  assetId: string
  trackId: string
  name: string
  startFrame: number
  sourceOffsetFrames: number
  lengthFrames: number
  assetSampleRate: number
  assetChannels: number
}

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

export interface MixerGraphSnapshot {
  sampleRate: number
  channels: MixerChannelState[]
  clips: TimelineClipState[]
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

export type CompiledAudioGraphEdgeKind = "signal" | "main-route" | "send-route" | "hardware-route"

export interface CompiledAudioGraphNode {
  id: string
  kind: CompiledAudioGraphNodeKind
  label: string
  channelId: string | null
  pluginInstanceId: string | null
  signalWidth: CompiledAudioGraphSignalWidth
  latencySamples: number
  pluginState: CompiledAudioGraphPluginState | null
}

export interface CompiledAudioGraphEdge {
  id: string
  source: string
  target: string
  kind: CompiledAudioGraphEdgeKind
  signalWidth: CompiledAudioGraphSignalWidth
}

export interface CompiledAudioGraphSnapshot {
  graphRevision: number
  buildGeneration: number
  sampleRate: number
  nodes: CompiledAudioGraphNode[]
  edges: CompiledAudioGraphEdge[]
}

export type MixerSendPatch = Partial<
  Pick<
    MixerSendState,
    "targetChannelId" | "targetBus" | "sortOrder" | "enabled" | "tap" | "levelDb"
  >
>

export type PluginInstancePatch = Partial<
  Pick<
    PluginInstanceState,
    "slotOrder" | "enabled" | "componentState" | "controllerState" | "araDocumentState"
  >
>

export type ProjectCommand =
  | { type: "create-channel"; channel: MixerChannelState }
  | { type: "delete-channel"; channelId: string }
  | { type: "update-channel"; channelId: string; patch: MixerChannelPatch }
  | { type: "create-send"; send: MixerSendState }
  | { type: "delete-send"; sendId: string }
  | { type: "update-send"; sendId: string; patch: MixerSendPatch }
  | { type: "create-clip"; clip: TimelineClipState }
  | { type: "delete-clip"; clipId: string }
  | { type: "move-clip"; clipId: string; trackId: string; startFrame: number }
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
  graph: MixerGraphSnapshot
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

export type TransportState = "stopped" | "waiting" | "playing" | "recording"
export type TransportWaitingAction = "play" | "record"
export type TransportClockSource = "internal" | "external"
export interface TransportSnapshot {
  state: TransportState
  positionFrames: number
  positionTicks?: number
  sampleRate: number
  effectiveBpm?: number
  clockSource?: TransportClockSource
  waitingFor?: TransportWaitingAction | null
}

export type TransportCommand =
  | { type: "play" }
  | { type: "record" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "seek"; positionFrames: number }
