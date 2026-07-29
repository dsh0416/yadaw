import {
  MIN_MIDI_NOTE_DURATION_TICKS,
  MUSICAL_TICKS_PER_WHOLE_NOTE,
  type MidiClipState,
  type MidiNotePatch,
  type MidiNoteState,
  type ProjectCommand
} from "@yadaw/contracts"

export const WHOLE_NOTE_TICKS = MUSICAL_TICKS_PER_WHOLE_NOTE
export const MIN_NOTE_TICKS = MIN_MIDI_NOTE_DURATION_TICKS

export const PIANO_ROLL_SNAP_OPTIONS = [
  { value: "off", label: "Off · 1/3840", ticks: 1 },
  { value: "1/1", label: "1/1", ticks: 3_840 },
  { value: "1/2", label: "1/2", ticks: 1_920 },
  { value: "1/4", label: "1/4", ticks: 960 },
  { value: "1/8", label: "1/8", ticks: 480 },
  { value: "1/16", label: "1/16", ticks: 240 },
  { value: "1/32", label: "1/32", ticks: 120 },
  { value: "1/64", label: "1/64", ticks: 60 },
  { value: "1/2T", label: "1/2 triplet", ticks: 1_280 },
  { value: "1/4T", label: "1/4 triplet", ticks: 640 },
  { value: "1/8T", label: "1/8 triplet", ticks: 320 },
  { value: "1/16T", label: "1/16 triplet", ticks: 160 },
  { value: "1/32T", label: "1/32 triplet", ticks: 80 },
  { value: "1/64T", label: "1/64 triplet", ticks: 40 }
] as const

export type PianoRollSnap = (typeof PIANO_ROLL_SNAP_OPTIONS)[number]["value"]

export function snapTicks(value: number, snap: PianoRollSnap): number {
  const step = PIANO_ROLL_SNAP_OPTIONS.find((option) => option.value === snap)?.ticks ?? 1
  return Math.max(0, Math.round(value / step) * step)
}

export function snapStep(snap: PianoRollSnap): number {
  return PIANO_ROLL_SNAP_OPTIONS.find((option) => option.value === snap)?.ticks ?? 1
}

export function midiNoteName(key: number): string {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
  return `${names[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`
}

export function noteGlobalStart(clip: MidiClipState, note: MidiNoteState): number {
  return clip.startTick + note.startTick - clip.sourceOffsetTicks
}

export interface DesiredNoteEdit {
  noteId: string
  globalStartTick: number
  durationTicks: number
  patch?: Omit<MidiNotePatch, "startTick" | "durationTicks">
}

export interface PlannedClipEdit {
  commands: ProjectCommand[]
  startTick: number
  lengthTicks: number
  sourceOffsetTicks: number
}

export function planExistingNoteEdits(
  clip: MidiClipState,
  edits: DesiredNoteEdit[]
): PlannedClipEdit {
  if (edits.length === 0) {
    return {
      commands: [],
      startTick: clip.startTick,
      lengthTicks: clip.lengthTicks,
      sourceOffsetTicks: clip.sourceOffsetTicks
    }
  }

  const normalized = edits.map((edit) => ({
    ...edit,
    globalStartTick: Math.max(0, Math.round(edit.globalStartTick)),
    durationTicks: Math.max(MIN_NOTE_TICKS, Math.round(edit.durationTicks))
  }))
  const earliest = Math.min(...normalized.map((edit) => edit.globalStartTick))
  const latest = Math.max(
    clip.startTick + clip.lengthTicks,
    ...normalized.map((edit) => edit.globalStartTick + edit.durationTicks)
  )
  const leftGrowth = Math.max(0, clip.startTick - earliest)
  const nextStartTick = clip.startTick - leftGrowth
  const offsetReduction = Math.min(leftGrowth, clip.sourceOffsetTicks)
  const nextSourceOffsetTicks = clip.sourceOffsetTicks - offsetReduction
  const rebaseTicks = leftGrowth - offsetReduction
  const nextLengthTicks = Math.max(
    MIN_NOTE_TICKS,
    clip.lengthTicks + leftGrowth,
    latest - nextStartTick
  )

  const commands: ProjectCommand[] = []
  if (rebaseTicks > 0) {
    commands.push({
      type: "rebase-midi-clip-content",
      clipId: clip.id,
      deltaTicks: rebaseTicks
    })
  }
  if (
    nextStartTick !== clip.startTick ||
    nextLengthTicks !== clip.lengthTicks ||
    nextSourceOffsetTicks !== clip.sourceOffsetTicks
  ) {
    commands.push({
      type: "update-midi-clip-range",
      clipId: clip.id,
      patch: {
        startTick: nextStartTick,
        lengthTicks: nextLengthTicks,
        sourceOffsetTicks: nextSourceOffsetTicks
      }
    })
  }
  commands.push({
    type: "update-midi-notes",
    clipId: clip.id,
    updates: normalized.map((edit) => ({
      noteId: edit.noteId,
      patch: {
        ...edit.patch,
        startTick: edit.globalStartTick - nextStartTick + nextSourceOffsetTicks,
        durationTicks: edit.durationTicks
      }
    }))
  })
  return {
    commands,
    startTick: nextStartTick,
    lengthTicks: nextLengthTicks,
    sourceOffsetTicks: nextSourceOffsetTicks
  }
}

export function planCreatedNotes(
  clip: MidiClipState,
  notes: Array<Omit<MidiNoteState, "startTick"> & { globalStartTick: number }>
): PlannedClipEdit {
  const provisional = notes.map((note) => ({
    noteId: note.id,
    globalStartTick: note.globalStartTick,
    durationTicks: note.durationTicks
  }))
  const range = planExistingNoteEdits(clip, provisional)
  const commands = range.commands.filter((command) => command.type !== "update-midi-notes")
  commands.push({
    type: "create-midi-notes",
    clipId: clip.id,
    notes: notes.map(({ globalStartTick, ...note }) => ({
      ...note,
      startTick: Math.max(
        0,
        Math.round(globalStartTick) - range.startTick + range.sourceOffsetTicks
      ),
      durationTicks: Math.max(MIN_NOTE_TICKS, Math.round(note.durationTicks))
    }))
  })
  return { ...range, commands }
}
