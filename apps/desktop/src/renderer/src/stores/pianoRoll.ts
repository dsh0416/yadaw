import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { MidiNoteState } from "@yadaw/contracts"
import type { PianoRollSnap } from "../utils/pianoRoll"

export interface PianoRollNoteRef {
  clipId: string
  noteId: string
}

export interface PianoRollClipboardNote extends Omit<MidiNoteState, "id" | "startTick"> {
  offsetTick: number
}

export type PianoRollEditCommand = "cut" | "copy" | "paste" | "select-all"

export const PIANO_ROLL_MIN_PIXELS_PER_QUARTER = 40
export const PIANO_ROLL_MAX_PIXELS_PER_QUARTER = 960
export const PIANO_ROLL_MIN_ROW_HEIGHT = 10
export const PIANO_ROLL_MAX_ROW_HEIGHT = 32

const noteRefKey = (value: PianoRollNoteRef): string => `${value.clipId}:${value.noteId}`

export const usePianoRollStore = defineStore("piano-roll", () => {
  const arrangementClipIds = shallowRef<string[]>([])
  const openClipIds = shallowRef<string[]>([])
  const activeClipId = shallowRef<string | null>(null)
  const selectedNotes = shallowRef<PianoRollNoteRef[]>([])
  const tool = shallowRef<"select" | "draw" | "erase">("select")
  const snap = shallowRef<PianoRollSnap>("1/16")
  const pixelsPerQuarter = shallowRef(120)
  const rowHeight = shallowRef(18)
  const editCursorTick = shallowRef(0)
  const editCursorKey = shallowRef(60)
  const clipboard = shallowRef<PianoRollClipboardNote[]>([])
  const editorFocused = shallowRef(false)
  let editCommandHandler: ((command: PianoRollEditCommand) => void) | null = null

  const selectedNoteKeys = computed(
    () => new Set(selectedNotes.value.map((value) => noteRefKey(value)))
  )

  function setPixelsPerQuarter(value: number): void {
    pixelsPerQuarter.value = Math.max(
      PIANO_ROLL_MIN_PIXELS_PER_QUARTER,
      Math.min(PIANO_ROLL_MAX_PIXELS_PER_QUARTER, Math.round(value))
    )
  }

  function setRowHeight(value: number): void {
    rowHeight.value = Math.max(
      PIANO_ROLL_MIN_ROW_HEIGHT,
      Math.min(PIANO_ROLL_MAX_ROW_HEIGHT, Math.round(value))
    )
  }

  function selectArrangementClip(clipId: string, additive = false): void {
    if (!additive) arrangementClipIds.value = [clipId]
    else if (arrangementClipIds.value.includes(clipId)) {
      arrangementClipIds.value = arrangementClipIds.value.filter((id) => id !== clipId)
    } else arrangementClipIds.value = [...arrangementClipIds.value, clipId]
  }

  function clearArrangementSelection(): void {
    arrangementClipIds.value = []
  }

  function openSelection(clickedClipId: string): void {
    const ids = arrangementClipIds.value.includes(clickedClipId)
      ? arrangementClipIds.value
      : [clickedClipId]
    openClipSet(ids, clickedClipId)
  }

  function openClipSet(clipIds: string[], activeId: string): void {
    openClipIds.value = [...new Set([...clipIds, activeId])]
    activeClipId.value = activeId
    selectedNotes.value = []
  }

  function activateClip(clipId: string): void {
    if (openClipIds.value.includes(clipId)) activeClipId.value = clipId
  }

  function closeEditor(): void {
    openClipIds.value = []
    activeClipId.value = null
    selectedNotes.value = []
  }

  function selectNote(value: PianoRollNoteRef, additive = false): void {
    activeClipId.value = value.clipId
    if (!additive) selectedNotes.value = [value]
    else if (selectedNoteKeys.value.has(noteRefKey(value))) {
      selectedNotes.value = selectedNotes.value.filter(
        (candidate) => noteRefKey(candidate) !== noteRefKey(value)
      )
    } else selectedNotes.value = [...selectedNotes.value, value]
  }

  function setSelectedNotes(values: PianoRollNoteRef[]): void {
    const unique = new Map(values.map((value) => [noteRefKey(value), value]))
    selectedNotes.value = [...unique.values()]
  }

  function clearNoteSelection(): void {
    selectedNotes.value = []
  }

  function reconcile(clipIds: Set<string>, noteIds: Set<string>): void {
    arrangementClipIds.value = arrangementClipIds.value.filter((id) => clipIds.has(id))
    openClipIds.value = openClipIds.value.filter((id) => clipIds.has(id))
    selectedNotes.value = selectedNotes.value.filter(
      (value) => clipIds.has(value.clipId) && noteIds.has(noteRefKey(value))
    )
    if (!activeClipId.value || !openClipIds.value.includes(activeClipId.value)) {
      activeClipId.value = openClipIds.value[0] ?? null
    }
  }

  function registerEditCommandHandler(
    handler: (command: PianoRollEditCommand) => void
  ): () => void {
    editCommandHandler = handler
    return () => {
      if (editCommandHandler === handler) editCommandHandler = null
    }
  }

  function executeEditCommand(command: PianoRollEditCommand): boolean {
    if (!editorFocused.value || !editCommandHandler) return false
    editCommandHandler(command)
    return true
  }

  function reset(): void {
    arrangementClipIds.value = []
    openClipIds.value = []
    activeClipId.value = null
    selectedNotes.value = []
    tool.value = "select"
    snap.value = "1/16"
    editCursorTick.value = 0
    editCursorKey.value = 60
    clipboard.value = []
    editorFocused.value = false
  }

  return {
    arrangementClipIds,
    openClipIds,
    activeClipId,
    selectedNotes,
    selectedNoteKeys,
    tool,
    snap,
    pixelsPerQuarter,
    rowHeight,
    editCursorTick,
    editCursorKey,
    clipboard,
    editorFocused,
    setPixelsPerQuarter,
    setRowHeight,
    selectArrangementClip,
    clearArrangementSelection,
    openSelection,
    openClipSet,
    activateClip,
    closeEditor,
    selectNote,
    setSelectedNotes,
    clearNoteSelection,
    reconcile,
    registerEditCommandHandler,
    executeEditCommand,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePianoRollStore, import.meta.hot))
}
