import { computed, shallowRef, type ComputedRef } from "vue"
import type {
  MidiClipState,
  MidiNotePatch,
  MidiNoteState,
  ProjectCommand
} from "@yadaw/contracts"
import type { usePianoRollStore } from "../../stores/pianoRoll"
import {
  MIN_NOTE_TICKS,
  noteGlobalStart,
  planCreatedNotes,
  planExistingNoteEdits,
  snapStep,
  snapTicks,
  type PlannedClipEdit
} from "../../utils/pianoRoll"

export interface NoteGestureItem {
  clip: MidiClipState
  note: MidiNoteState
  globalStartTick: number
}

export interface PianoRollNoteEdit extends NoteGestureItem {
  durationTicks: number
  patch?: Omit<MidiNotePatch, "startTick" | "durationTicks">
}

interface Gesture {
  startX: number
  startY: number
  currentX: number
  currentY: number
  mode: "move" | "resize-left" | "resize-right"
  items: NoteGestureItem[]
}

export interface PianoRollGestureDependencies {
  pianoRollStore: ReturnType<typeof usePianoRollStore>
  pixelsPerTick: ComputedRef<number>
  selectedItems: ComputedRef<NoteGestureItem[]>
  activeClip: ComputedRef<MidiClipState | null>
  batch: (commands: ProjectCommand[]) => Promise<boolean>
  commandsForEdits: (values: PianoRollNoteEdit[]) => ProjectCommand[]
}

export interface PianoRollGestures {
  gestureNotePreviews: ComputedRef<
    Map<string, { globalStartTick: number; durationTicks: number; key: number }>
  >
  gestureClipRanges: ComputedRef<Map<string, PlannedClipEdit>>
  beginNoteGesture: (
    event: PointerEvent,
    clip: MidiClipState,
    note: MidiNoteState,
    mode: Gesture["mode"]
  ) => void
  updateNoteGesture: (event: PointerEvent) => void
  finishNoteGesture: (event: PointerEvent) => void
  cancelNoteGesture: () => void
  handleNoteClick: (event: MouseEvent, clip: MidiClipState, note: MidiNoteState) => void
  handleGridPointerDown: (event: PointerEvent) => void
}

export function createPianoRollGestures(
  dependencies: PianoRollGestureDependencies
): PianoRollGestures {
  const { pianoRollStore, pixelsPerTick, selectedItems, activeClip, batch, commandsForEdits } =
    dependencies
  const gesture = shallowRef<Gesture | null>(null)
  let suppressedNoteClickKey: string | null = null

  function editsForGesture(
    current: Gesture,
    clientX: number,
    clientY: number
  ): PianoRollNoteEdit[] {
    const rawTickDelta = (clientX - current.startX) / pixelsPerTick.value
    const step = snapStep(pianoRollStore.snap)
    const tickDelta = Math.round(rawTickDelta / step) * step
    const rawKeyDelta = -Math.round((clientY - current.startY) / pianoRollStore.rowHeight)
    const minimumStart = Math.min(...current.items.map((item) => item.globalStartTick))
    const minimumKey = Math.min(...current.items.map((item) => item.note.key))
    const maximumKey = Math.max(...current.items.map((item) => item.note.key))
    const moveTickDelta = Math.max(-minimumStart, tickDelta)
    const keyDelta = Math.max(-minimumKey, Math.min(127 - maximumKey, rawKeyDelta))

    return current.items.map((item) => {
      if (current.mode === "resize-right") {
        return {
          ...item,
          durationTicks: Math.max(MIN_NOTE_TICKS, item.note.durationTicks + tickDelta)
        }
      }
      if (current.mode === "resize-left") {
        const requested = Math.min(item.note.durationTicks - MIN_NOTE_TICKS, tickDelta)
        const globalStartTick = Math.max(0, item.globalStartTick + requested)
        const applied = globalStartTick - item.globalStartTick
        return {
          ...item,
          globalStartTick,
          durationTicks: item.note.durationTicks - applied
        }
      }
      return {
        ...item,
        globalStartTick: item.globalStartTick + moveTickDelta,
        durationTicks: item.note.durationTicks,
        patch: { key: item.note.key + keyDelta }
      }
    })
  }

  const gestureEdits = computed(() => {
    const current = gesture.value
    return current ? editsForGesture(current, current.currentX, current.currentY) : []
  })
  const gestureNotePreviews = computed(
    () =>
      new Map(
        gestureEdits.value.map((edit) => [
          `${edit.clip.id}:${edit.note.id}`,
          {
            globalStartTick: edit.globalStartTick,
            durationTicks: edit.durationTicks,
            key: edit.patch?.key ?? edit.note.key
          }
        ])
      )
  )
  const gestureClipRanges = computed(() => {
    const byClip = new Map<string, PianoRollNoteEdit[]>()
    for (const edit of gestureEdits.value) {
      const values = byClip.get(edit.clip.id) ?? []
      values.push(edit)
      byClip.set(edit.clip.id, values)
    }
    return new Map(
      [...byClip].map(([clipId, edits]) => {
        const clip = edits[0]!.clip
        const plan = planExistingNoteEdits(
          clip,
          edits.map((edit) => ({
            noteId: edit.note.id,
            globalStartTick: edit.globalStartTick,
            durationTicks: edit.durationTicks,
            patch: edit.patch
          }))
        )
        return [clipId, plan]
      })
    )
  })

  function beginNoteGesture(
    event: PointerEvent,
    clip: MidiClipState,
    note: MidiNoteState,
    mode: Gesture["mode"]
  ): void {
    event.stopPropagation()
    const reference = { clipId: clip.id, noteId: note.id }
    const key = `${clip.id}:${note.id}`
    suppressedNoteClickKey = key
    if (!pianoRollStore.selectedNoteKeys.has(key)) {
      pianoRollStore.selectNote(reference, event.ctrlKey || event.metaKey)
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    gesture.value = {
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      mode,
      items: selectedItems.value.map((item) => ({ ...item }))
    }
  }

  function updateNoteGesture(event: PointerEvent): void {
    const current = gesture.value
    if (!current) return
    event.preventDefault()
    gesture.value = { ...current, currentX: event.clientX, currentY: event.clientY }
  }

  function finishNoteGesture(event: PointerEvent): void {
    const current = gesture.value
    gesture.value = null
    if (!current) return
    const edits = editsForGesture(current, event.clientX, event.clientY).filter(
      (item) =>
        item.globalStartTick !== noteGlobalStart(item.clip, item.note) ||
        item.durationTicks !== item.note.durationTicks ||
        (item.patch?.key ?? item.note.key) !== item.note.key
    )
    if (edits.length > 0) void batch(commandsForEdits(edits))
    const key = suppressedNoteClickKey
    window.setTimeout(() => {
      if (suppressedNoteClickKey === key) suppressedNoteClickKey = null
    }, 0)
  }

  function cancelNoteGesture(): void {
    gesture.value = null
    suppressedNoteClickKey = null
  }

  function handleNoteClick(event: MouseEvent, clip: MidiClipState, note: MidiNoteState): void {
    const key = `${clip.id}:${note.id}`
    if (suppressedNoteClickKey === key) {
      suppressedNoteClickKey = null
      return
    }
    const additive = event.ctrlKey || event.metaKey
    if (!pianoRollStore.selectedNoteKeys.has(key) || additive) {
      pianoRollStore.selectNote({ clipId: clip.id, noteId: note.id }, additive)
    }
  }

  function gridPoint(event: PointerEvent): { tick: number; key: number } {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const tick = snapTicks((event.clientX - bounds.left) / pixelsPerTick.value, pianoRollStore.snap)
    const key = Math.max(
      0,
      Math.min(127, 127 - Math.floor((event.clientY - bounds.top) / pianoRollStore.rowHeight))
    )
    return { tick, key }
  }

  function handleGridPointerDown(event: PointerEvent): void {
    const point = gridPoint(event)
    pianoRollStore.editCursorTick = point.tick
    pianoRollStore.editCursorKey = point.key
    if (pianoRollStore.tool !== "draw" || !activeClip.value) {
      pianoRollStore.clearNoteSelection()
      return
    }
    const targetClip = activeClip.value
    const durationTicks = pianoRollStore.snap === "off" ? 240 : snapStep(pianoRollStore.snap)
    const noteId = crypto.randomUUID()
    const plan = planCreatedNotes(targetClip, [
      {
        id: noteId,
        globalStartTick: point.tick,
        durationTicks,
        channel: 0,
        key: point.key,
        velocity: 100,
        releaseVelocity: 0
      }
    ])
    void batch(plan.commands).then((created) => {
      if (created) pianoRollStore.selectNote({ clipId: targetClip.id, noteId })
    })
  }

  return {
    gestureNotePreviews,
    gestureClipRanges,
    beginNoteGesture,
    updateNoteGesture,
    finishNoteGesture,
    cancelNoteGesture,
    handleNoteClick,
    handleGridPointerDown
  }
}
