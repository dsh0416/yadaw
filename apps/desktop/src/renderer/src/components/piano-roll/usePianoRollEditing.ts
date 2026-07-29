import { onMounted, onUnmounted, type ComputedRef } from "vue"
import type { MidiClipState, MidiNotePatch, ProjectCommand } from "@yadaw/contracts"
import type { PianoRollNoteRef, usePianoRollStore } from "../../stores/pianoRoll"
import { MIN_NOTE_TICKS, planCreatedNotes, snapStep } from "../../utils/pianoRoll"
import type { NoteGestureItem, PianoRollNoteEdit } from "./usePianoRollGestures"

export interface PianoRollEditingDependencies {
  pianoRollStore: ReturnType<typeof usePianoRollStore>
  activeClip: ComputedRef<MidiClipState | null>
  visibleNotes: ComputedRef<NoteGestureItem[]>
  selectedItems: ComputedRef<NoteGestureItem[]>
  gestureNotePreviews: ComputedRef<
    Map<string, { globalStartTick: number; durationTicks: number; key: number }>
  >
  batch: (commands: ProjectCommand[]) => Promise<boolean>
  commandsForEdits: (values: PianoRollNoteEdit[]) => ProjectCommand[]
}

export interface PianoRollEditing {
  deleteSelected: () => void
  copySelected: () => void
  cutSelected: () => void
  paste: () => void
  selectAll: () => void
  applyInspector: (field: string, raw: string) => void
  commonValue: (field: string) => string
  moveSelection: (deltaTick: number, deltaKey: number, resize?: boolean) => void
  handleKeydown: (event: KeyboardEvent) => void
}

export function createPianoRollEditing(
  dependencies: PianoRollEditingDependencies
): PianoRollEditing {
  const {
    pianoRollStore,
    activeClip,
    visibleNotes,
    selectedItems,
    gestureNotePreviews,
    batch,
    commandsForEdits
  } = dependencies

  function deleteSelected(): void {
    const byClip = new Map<string, string[]>()
    for (const value of pianoRollStore.selectedNotes) {
      const ids = byClip.get(value.clipId) ?? []
      ids.push(value.noteId)
      byClip.set(value.clipId, ids)
    }
    const commands: ProjectCommand[] = [...byClip].map(([clipId, noteIds]) => ({
      type: "delete-midi-notes",
      clipId,
      noteIds
    }))
    void batch(commands).then((deleted) => {
      if (deleted) pianoRollStore.clearNoteSelection()
    })
  }

  function copySelected(): void {
    if (selectedItems.value.length === 0) return
    const first = Math.min(...selectedItems.value.map((item) => item.globalStartTick))
    pianoRollStore.clipboard = selectedItems.value.map(({ note, globalStartTick }) => ({
      offsetTick: globalStartTick - first,
      durationTicks: note.durationTicks,
      channel: note.channel,
      key: note.key,
      velocity: note.velocity,
      releaseVelocity: note.releaseVelocity
    }))
  }

  function cutSelected(): void {
    copySelected()
    deleteSelected()
  }

  function paste(): void {
    const clip = activeClip.value
    if (!clip || pianoRollStore.clipboard.length === 0) return
    const ids: PianoRollNoteRef[] = []
    const plan = planCreatedNotes(
      clip,
      pianoRollStore.clipboard.map((note) => {
        const id = crypto.randomUUID()
        ids.push({ clipId: clip.id, noteId: id })
        return {
          id,
          globalStartTick: pianoRollStore.editCursorTick + note.offsetTick,
          durationTicks: note.durationTicks,
          channel: note.channel,
          key: note.key,
          velocity: note.velocity,
          releaseVelocity: note.releaseVelocity
        }
      })
    )
    void batch(plan.commands).then((created) => {
      if (created) pianoRollStore.setSelectedNotes(ids)
    })
  }

  function selectAll(): void {
    pianoRollStore.setSelectedNotes(
      visibleNotes.value.map(({ clip, note }) => ({ clipId: clip.id, noteId: note.id }))
    )
  }

  function applyInspector(field: string, raw: string): void {
    if (selectedItems.value.length === 0 || raw.trim() === "") return
    const value = Math.round(Number(raw))
    if (!Number.isFinite(value)) return
    const edits = selectedItems.value.map((item) => {
      const patch: Omit<MidiNotePatch, "startTick" | "durationTicks"> = {}
      let globalStartTick = item.globalStartTick
      let durationTicks = item.note.durationTicks
      if (field === "start") globalStartTick = Math.max(0, value)
      else if (field === "duration") durationTicks = Math.max(MIN_NOTE_TICKS, value)
      else if (field === "key") patch.key = Math.max(0, Math.min(127, value))
      else if (field === "channel") patch.channel = Math.max(0, Math.min(15, value - 1))
      else if (field === "velocity") patch.velocity = Math.max(1, Math.min(127, value))
      else if (field === "releaseVelocity") {
        patch.releaseVelocity = Math.max(0, Math.min(127, value))
      }
      return { ...item, globalStartTick, durationTicks, patch }
    })
    void batch(commandsForEdits(edits))
  }

  function commonValue(field: string): string {
    if (selectedItems.value.length === 0) return ""
    const values = selectedItems.value.map((item) => {
      const preview = gestureNotePreviews.value.get(`${item.clip.id}:${item.note.id}`)
      if (field === "start") return preview?.globalStartTick ?? item.globalStartTick
      if (field === "duration") return preview?.durationTicks ?? item.note.durationTicks
      if (field === "channel") return item.note.channel + 1
      if (field === "key") return preview?.key ?? item.note.key
      return item.note[field as "key" | "velocity" | "releaseVelocity"]
    })
    return values.every((value) => value === values[0]) ? String(values[0]) : ""
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  }

  function moveSelection(deltaTick: number, deltaKey: number, resize = false): void {
    const edits = selectedItems.value.map((item) =>
      resize
        ? {
            ...item,
            durationTicks: Math.max(MIN_NOTE_TICKS, item.note.durationTicks + deltaTick)
          }
        : {
            ...item,
            globalStartTick: Math.max(0, item.globalStartTick + deltaTick),
            durationTicks: item.note.durationTicks,
            patch: { key: Math.max(0, Math.min(127, item.note.key + deltaKey)) }
          }
    )
    void batch(commandsForEdits(edits))
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) return
    const modifier = event.ctrlKey || event.metaKey
    if (modifier && event.code === "KeyC") copySelected()
    else if (modifier && event.code === "KeyX") cutSelected()
    else if (modifier && event.code === "KeyV") paste()
    else if (modifier && event.code === "KeyA") selectAll()
    else if (event.code === "Delete" || event.code === "Backspace") deleteSelected()
    else if (event.code === "ArrowUp") moveSelection(0, 1)
    else if (event.code === "ArrowDown") moveSelection(0, -1)
    else if (event.code === "ArrowLeft") {
      moveSelection(-snapStep(pianoRollStore.snap), 0, event.altKey)
    } else if (event.code === "ArrowRight") {
      moveSelection(snapStep(pianoRollStore.snap), 0, event.altKey)
    } else if (event.code === "Escape") pianoRollStore.clearNoteSelection()
    else return
    event.preventDefault()
  }

  let unregisterEditCommands: (() => void) | null = null
  onMounted(() => {
    unregisterEditCommands = pianoRollStore.registerEditCommandHandler((command) => {
      if (command === "copy") copySelected()
      else if (command === "cut") cutSelected()
      else if (command === "paste") paste()
      else selectAll()
    })
  })
  onUnmounted(() => unregisterEditCommands?.())

  return {
    deleteSelected,
    copySelected,
    cutSelected,
    paste,
    selectAll,
    applyInspector,
    commonValue,
    moveSelection,
    handleKeydown
  }
}
