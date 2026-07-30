export const MUSICAL_TICKS_PER_QUARTER = 960
export const MUSICAL_TICKS_PER_WHOLE_NOTE = MUSICAL_TICKS_PER_QUARTER * 4
export const MIN_MIDI_NOTE_DURATION_TICKS = 1
export const DEFAULT_INSTRUMENT_COLOR = "#73D6A2"

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
  notes: MidiNoteState[]
  events: MidiEventState[]
}

export type MidiClipRangePatch = Partial<
  Pick<MidiClipState, "startTick" | "lengthTicks" | "sourceOffsetTicks">
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
  | { type: "existing"; channelId: string; instrumentClassId?: string }
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
