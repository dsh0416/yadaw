import type { ProjectCommandResult } from "./mixer"
import type { ProjectWorkspaceSnapshot } from "./project"
import type { AudioHostRef, MidiRuntimeRef } from "./rpc"

export const MUSICAL_TICKS_PER_QUARTER = 960
export const MUSICAL_TICKS_PER_WHOLE_NOTE = MUSICAL_TICKS_PER_QUARTER * 4
export const MIN_MIDI_NOTE_DURATION_TICKS = 1
export const DEFAULT_INSTRUMENT_COLOR = "#73D6A2"
export const MIDI_CLOCKS_PER_QUARTER = 24
export const MUSICAL_TICKS_PER_MIDI_CLOCK = MUSICAL_TICKS_PER_QUARTER / MIDI_CLOCKS_PER_QUARTER
export const MUSICAL_TICKS_PER_SONG_POSITION = MUSICAL_TICKS_PER_MIDI_CLOCK * 6
export const MAX_MIDI_INPUT_OFFSET_MS = 500

export interface MidiInputRoute {
  /** `null` receives every connected MIDI input. */
  portId: string | null
  /** Retained so a disconnected route can still be identified in the UI. */
  portName: string | null
  /** Zero-based MIDI channel; `null` receives all channels. */
  channel: number | null
}

export interface MidiInputPort {
  id: string
  name: string
  connected: boolean
}

export type MidiSyncState = "internal" | "waiting" | "locking" | "locked" | "freewheel" | "lost"

export interface MidiSyncPreferences {
  enabled: boolean
  sourcePortId: string | null
  sourcePortName: string | null
  /** Per-port signed timing correction, in milliseconds. */
  inputOffsetsMs: Record<string, number>
}

export interface MidiSyncRuntimeSnapshot {
  state: MidiSyncState
  sourcePortId: string | null
  sourcePortName: string | null
  effectiveBpm: number | null
  jitterMicroseconds: number | null
  lastClockAgeMs: number | null
  droppedEvents: number
  ignoredSystemMessages: number
  error: string | null
}

export interface MidiControlEvent {
  generation: number
  timestampMicroseconds: number
  portId: string
  portName: string
  /** Zero-based MIDI channel. */
  channel: number
  type: "note" | "control-change"
  number: number
  value: number
}

export interface MidiInputSnapshot {
  ports: MidiInputPort[]
  sync: MidiSyncRuntimeSnapshot
  /** A bounded, generation-ordered window of recently received control events. */
  controlEvents: MidiControlEvent[]
  capturedAt: number
}

export interface MidiRuntimeResourceSnapshot {
  runtime: MidiRuntimeRef
  host: AudioHostRef
  revision: number
  snapshot: MidiInputSnapshot
}

export interface MidiImportCommitResult {
  command: ProjectCommandResult
  workspace: ProjectWorkspaceSnapshot
}

export interface TempoEventState {
  tick: number
  beatsPerMinute: number
}

export interface TimeSignatureEventState {
  tick: number
  numerator: number
  denominator: number
}

export type KeySignatureMode = "major" | "minor"

export interface KeySignatureEventState {
  tick: number
  fifths: number
  mode: KeySignatureMode
}

export interface TempoMapSnapshot {
  ticksPerQuarter: typeof MUSICAL_TICKS_PER_QUARTER
  tempoEvents: TempoEventState[]
  timeSignatureEvents: TimeSignatureEventState[]
}

export interface MidiNoteState {
  id: string
  startTick: number
  durationTicks: number
  channel: number
  key: number
  velocity: number
  releaseVelocity: number
}

export type MidiNotePatch = Partial<
  Pick<
    MidiNoteState,
    "startTick" | "durationTicks" | "channel" | "key" | "velocity" | "releaseVelocity"
  >
>

export type MidiEventKind =
  | "control-change"
  | "pitch-bend"
  | "program-change"
  | "channel-pressure"
  | "poly-pressure"
  | "sysex"

export interface MidiEventState {
  id: string
  tick: number
  channel: number | null
  kind: MidiEventKind
  data: Uint8Array
}

export interface MidiSourceState {
  id: string
  name: string
  contentHash: string
  rawBytes: Uint8Array
}

export interface MidiClipState {
  id: string
  sourceId: string
  trackId: string
  name: string
  startTick: number
  lengthTicks: number
  sourceOffsetTicks: number
  sourceLengthTicks: number
  notes: MidiNoteState[]
  events: MidiEventState[]
}

export type MidiClipRangePatch = Partial<
  Pick<MidiClipState, "startTick" | "lengthTicks" | "sourceOffsetTicks" | "sourceLengthTicks">
>

export interface MidiImportTrackPreview {
  sourceTrack: number
  sequence: number
  name: string
  noteCount: number
  eventCount: number
  lengthTicks: number
  tempoMap: TempoMapSnapshot
  warnings: string[]
}

export interface MidiImportPreview {
  token: string
  path: string
  format: 0 | 1 | 2
  sourceTiming: string
  tracks: MidiImportTrackPreview[]
  tempoMap: TempoMapSnapshot
  warnings: string[]
}

export type MidiImportTrackTarget =
  | { type: "ignore" }
  | { type: "existing"; trackId: string; instrumentClassId?: string }
  | { type: "new"; name?: string; instrumentClassId?: string }

export interface MidiImportPlan {
  token: string
  importTempoMap: boolean
  insertionTick: number
  tracks: Array<{
    sourceTrack: number
    sequence: number
    target: MidiImportTrackTarget
  }>
}
