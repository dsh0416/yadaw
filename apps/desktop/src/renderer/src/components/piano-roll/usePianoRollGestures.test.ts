import { createPinia, setActivePinia } from "pinia"
import { computed, nextTick, ref } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MidiClipState, MidiNoteState, ProjectCommand } from "@yadaw/contracts"
import { usePianoRollStore } from "../../stores/pianoRoll"
import {
  createPianoRollGestures,
  type NoteGestureItem,
  type PianoRollNoteEdit
} from "./usePianoRollGestures"

const clip: MidiClipState = {
  id: "clip-1",
  sourceId: "source-1",
  trackId: "track:instrument-1",
  name: "Verse",
  startTick: 960,
  lengthTicks: 960,
  sourceOffsetTicks: 0,
  notes: [
    {
      id: "note-1",
      startTick: 0,
      durationTicks: 240,
      channel: 0,
      key: 60,
      velocity: 100,
      releaseVelocity: 0
    },
    {
      id: "note-2",
      startTick: 480,
      durationTicks: 240,
      channel: 0,
      key: 64,
      velocity: 90,
      releaseVelocity: 0
    }
  ],
  events: []
}

function noteItem(note: MidiNoteState, source = clip): NoteGestureItem {
  return {
    clip: source,
    note,
    globalStartTick: source.startTick + note.startTick - source.sourceOffsetTicks
  }
}

function pointerEvent(
  type: string,
  options: {
    clientX: number
    clientY: number
    pointerId?: number
    altKey?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
    shiftKey?: boolean
    button?: number
  },
  target?: HTMLElement
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX,
    clientY: options.clientY,
    pointerId: options.pointerId ?? 1,
    altKey: options.altKey,
    ctrlKey: options.ctrlKey,
    metaKey: options.metaKey,
    shiftKey: options.shiftKey,
    button: options.button ?? 0
  })
  if (target) {
    Object.defineProperty(event, "currentTarget", { value: target })
  }
  return event
}

function gridTarget(left = 0, top = 0): HTMLElement {
  const element = document.createElement("div")
  element.setPointerCapture = vi.fn()
  element.releasePointerCapture = vi.fn()
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    top,
    right: left + 1_000,
    bottom: top + 2_304,
    left,
    width: 1_000,
    height: 2_304,
    toJSON: () => ({})
  })
  return element
}

describe("createPianoRollGestures", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function setup(options?: {
    selected?: NoteGestureItem[]
    visible?: NoteGestureItem[]
    active?: MidiClipState | null
    commandsForEdits?: (values: PianoRollNoteEdit[]) => ProjectCommand[]
  }) {
    const pianoRollStore = usePianoRollStore()
    pianoRollStore.snap = "1/16"
    pianoRollStore.rowHeight = 18
    const selectedItems = computed(() => options?.selected ?? [])
    const visibleNotes = computed(
      () => options?.visible ?? clip.notes.map((note) => noteItem(note))
    )
    const activeClip = computed(() => (options?.active === undefined ? clip : options.active))
    const batch = vi.fn(async () => true)
    const commandsForEdits =
      options?.commandsForEdits ??
      vi.fn((values: PianoRollNoteEdit[]) => [
        {
          type: "update-midi-notes" as const,
          clipId: values[0]!.clip.id,
          updates: values.map((value) => ({
            noteId: value.note.id,
            patch: {
              startTick: value.globalStartTick - value.clip.startTick,
              durationTicks: value.durationTicks,
              ...value.patch
            }
          }))
        }
      ])
    const gestures = createPianoRollGestures({
      pianoRollStore,
      pixelsPerTick: computed(() => 1),
      visibleNotes,
      selectedItems,
      activeClip,
      trackColor: () => "#73D6A2",
      batch,
      commandsForEdits
    })
    return { pianoRollStore, gestures, batch, commandsForEdits }
  }

  it("previews and commits a move gesture with snapped tick and key deltas", async () => {
    const item = noteItem(clip.notes[0]!)
    const { pianoRollStore, gestures, batch, commandsForEdits } = setup({ selected: [item] })
    pianoRollStore.selectNote({ clipId: clip.id, noteId: item.note.id })
    const target = gridTarget()

    gestures.beginNoteGesture(
      pointerEvent("pointerdown", { clientX: 100, clientY: 100 }, target),
      clip,
      item.note,
      "move"
    )
    gestures.updateNoteGesture(pointerEvent("pointermove", { clientX: 340, clientY: 82 }))
    await nextTick()

    expect(gestures.gestureNotePreviews.value.get("clip-1:note-1")).toEqual({
      globalStartTick: 1_200,
      durationTicks: 240,
      key: 61
    })
    expect(gestures.gestureClipRanges.value.get("clip-1")).toMatchObject({
      startTick: 960,
      lengthTicks: expect.any(Number)
    })

    gestures.finishNoteGesture(pointerEvent("pointerup", { clientX: 340, clientY: 82 }))
    await nextTick()

    expect(commandsForEdits).toHaveBeenCalled()
    expect(batch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ type: "update-midi-notes" })])
    )
  })

  it("resizes notes from the right and left edges", async () => {
    const item = noteItem(clip.notes[0]!)
    const { pianoRollStore, gestures, batch } = setup({ selected: [item] })
    pianoRollStore.selectNote({ clipId: clip.id, noteId: item.note.id })
    const target = gridTarget()

    gestures.beginNoteGesture(
      pointerEvent("pointerdown", { clientX: 100, clientY: 100 }, target),
      clip,
      item.note,
      "resize-right"
    )
    gestures.updateNoteGesture(pointerEvent("pointermove", { clientX: 340, clientY: 100 }))
    await nextTick()
    expect(gestures.gestureNotePreviews.value.get("clip-1:note-1")?.durationTicks).toBe(480)
    gestures.finishNoteGesture(pointerEvent("pointerup", { clientX: 340, clientY: 100 }))
    expect(batch).toHaveBeenCalled()

    batch.mockClear()
    gestures.beginNoteGesture(
      pointerEvent("pointerdown", { clientX: 100, clientY: 100 }, target),
      clip,
      item.note,
      "resize-left"
    )
    gestures.updateNoteGesture(pointerEvent("pointermove", { clientX: 340, clientY: 100 }))
    await nextTick()
    const preview = gestures.gestureNotePreviews.value.get("clip-1:note-1")
    // Left resize clamps so duration stays at least MIN_NOTE_TICKS (1).
    expect(preview?.globalStartTick).toBe(1_199)
    expect(preview?.durationTicks).toBe(1)
    gestures.cancelNoteGesture()
    expect(gestures.gestureNotePreviews.value.size).toBe(0)
  })

  it("does not commit a note gesture that ends without movement", async () => {
    const item = noteItem(clip.notes[0]!)
    const { pianoRollStore, gestures, batch } = setup({ selected: [item] })
    pianoRollStore.selectNote({ clipId: clip.id, noteId: item.note.id })
    const target = gridTarget()

    gestures.beginNoteGesture(
      pointerEvent("pointerdown", { clientX: 50, clientY: 50 }, target),
      clip,
      item.note,
      "move"
    )
    gestures.finishNoteGesture(pointerEvent("pointerup", { clientX: 50, clientY: 50 }))
    expect(batch).not.toHaveBeenCalled()
  })

  it("erases on alt-click and accumulates erase-tool targets until pointerup", async () => {
    const item = noteItem(clip.notes[0]!)
    const second = noteItem(clip.notes[1]!)
    const { pianoRollStore, gestures, batch } = setup()
    const target = gridTarget()

    gestures.beginNoteGesture(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10, altKey: true }, target),
      clip,
      item.note,
      "move"
    )
    expect(batch).toHaveBeenCalledWith([
      { type: "delete-midi-notes", clipId: "clip-1", noteIds: ["note-1"] }
    ])

    batch.mockClear()
    pianoRollStore.tool = "erase"
    gestures.beginNoteGesture(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10 }, target),
      clip,
      item.note,
      "move"
    )
    expect(gestures.eraseTargetKeys.value.has("clip-1:note-1")).toBe(true)
    gestures.handleNotePointerOver(clip, second.note)
    expect(gestures.eraseTargetKeys.value.has("clip-1:note-2")).toBe(true)

    window.dispatchEvent(new Event("pointerup"))
    await nextTick()
    expect(batch).toHaveBeenCalledWith([
      { type: "delete-midi-notes", clipId: "clip-1", noteIds: ["note-1", "note-2"] }
    ])
  })

  it("starts erase from the grid and finishes on grid pointerup", async () => {
    const { pianoRollStore, gestures, batch } = setup()
    pianoRollStore.tool = "erase"
    const target = gridTarget()

    gestures.handleGridPointerDown(
      pointerEvent("pointerdown", { clientX: 100, clientY: 100 }, target)
    )
    expect(gestures.eraseTargetKeys.value.size).toBe(0)
    gestures.handleNotePointerOver(clip, clip.notes[0]!)
    expect(gestures.eraseTargetKeys.value.has("clip-1:note-1")).toBe(true)

    gestures.handleGridPointerUp(pointerEvent("pointerup", { clientX: 100, clientY: 100 }, target))
    await nextTick()
    expect(batch).toHaveBeenCalledWith([
      { type: "delete-midi-notes", clipId: "clip-1", noteIds: ["note-1"] }
    ])
  })

  it("draws a create preview and commits a new note on release", async () => {
    const { pianoRollStore, gestures, batch } = setup()
    pianoRollStore.tool = "draw"
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000099")
    const target = gridTarget()

    gestures.handleGridPointerDown(
      pointerEvent("pointerdown", { clientX: 240, clientY: 18 * (127 - 60) }, target)
    )
    await nextTick()
    expect(gestures.createPreviewStyle.value).toMatchObject({
      left: "240px",
      "--note-color": "#73D6A2"
    })

    gestures.handleGridPointerMove(
      pointerEvent("pointermove", { clientX: 720, clientY: 18 * (127 - 60) }, target)
    )
    await nextTick()
    expect(gestures.createPreviewStyle.value?.width).toBe("480px")

    gestures.handleGridPointerUp(
      pointerEvent("pointerup", { clientX: 720, clientY: 18 * (127 - 60) }, target)
    )
    await nextTick()

    expect(batch).toHaveBeenCalled()
    const commands = batch.mock.calls[0]![0] as ProjectCommand[]
    expect(commands.some((command) => command.type === "create-midi-notes")).toBe(true)
    expect(pianoRollStore.selectedNoteKeys.has("clip-1:00000000-0000-4000-8000-000000000099")).toBe(
      true
    )
  })

  it("ignores draw gestures when there is no active clip", () => {
    const { pianoRollStore, gestures, batch } = setup({ active: null })
    pianoRollStore.tool = "draw"
    const target = gridTarget()
    gestures.handleGridPointerDown(
      pointerEvent("pointerdown", { clientX: 100, clientY: 100 }, target)
    )
    gestures.handleGridPointerUp(pointerEvent("pointerup", { clientX: 100, clientY: 100 }, target))
    expect(batch).not.toHaveBeenCalled()
    expect(gestures.createPreviewStyle.value).toBeNull()
  })

  it("updates marquee selection while dragging and clears on a plain click", async () => {
    const { pianoRollStore, gestures } = setup({
      visible: clip.notes.map((note) => noteItem(note))
    })
    const target = gridTarget()

    gestures.handleGridPointerDown(
      pointerEvent("pointerdown", { clientX: 900, clientY: 10 }, target)
    )
    gestures.handleGridPointerMove(
      pointerEvent("pointermove", { clientX: 901, clientY: 11 }, target)
    )
    await nextTick()
    expect(gestures.marqueeStyle.value).toBeNull()

    gestures.handleGridPointerMove(
      pointerEvent("pointermove", { clientX: 1_200, clientY: 18 * (127 - 59) }, target)
    )
    await nextTick()
    expect(gestures.marqueeStyle.value).toMatchObject({
      width: "300px"
    })
    expect(pianoRollStore.selectedNoteKeys.has("clip-1:note-1")).toBe(true)

    gestures.handleGridPointerUp(
      pointerEvent("pointerup", { clientX: 1_200, clientY: 18 * (127 - 59) }, target)
    )

    gestures.handleGridPointerDown(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10 }, target)
    )
    gestures.handleGridPointerUp(pointerEvent("pointerup", { clientX: 10, clientY: 10 }, target))
    expect(pianoRollStore.selectedNotes).toHaveLength(0)
  })

  it("supports additive marquee selection", async () => {
    const { pianoRollStore, gestures } = setup({
      visible: clip.notes.map((note) => noteItem(note))
    })
    pianoRollStore.setSelectedNotes([{ clipId: "clip-1", noteId: "note-2" }])
    const target = gridTarget()

    gestures.handleGridPointerDown(
      pointerEvent("pointerdown", { clientX: 900, clientY: 18 * (127 - 61), shiftKey: true }, target)
    )
    gestures.handleGridPointerMove(
      pointerEvent(
        "pointermove",
        { clientX: 1_200, clientY: 18 * (127 - 59), shiftKey: true },
        target
      )
    )
    await nextTick()
    expect(pianoRollStore.selectedNoteKeys.has("clip-1:note-1")).toBe(true)
    expect(pianoRollStore.selectedNoteKeys.has("clip-1:note-2")).toBe(true)
  })

  it("handles note clicks for selection and suppresses post-gesture clicks", () => {
    const { pianoRollStore, gestures } = setup()
    const note = clip.notes[0]!
    const target = gridTarget()

    gestures.handleNoteClick(new MouseEvent("click", { bubbles: true }), clip, note)
    expect(pianoRollStore.selectedNoteKeys.has("clip-1:note-1")).toBe(true)

    gestures.beginNoteGesture(
      pointerEvent("pointerdown", { clientX: 0, clientY: 0 }, target),
      clip,
      note,
      "move"
    )
    gestures.handleNoteClick(new MouseEvent("click", { bubbles: true }), clip, note)
    expect(pianoRollStore.selectedNotes).toHaveLength(1)

    pianoRollStore.tool = "erase"
    pianoRollStore.clearNoteSelection()
    gestures.handleNoteClick(new MouseEvent("click", { bubbles: true }), clip, note)
    expect(pianoRollStore.selectedNotes).toHaveLength(0)
  })

  it("cancels in-progress grid gestures without committing", async () => {
    const { pianoRollStore, gestures, batch } = setup()
    pianoRollStore.tool = "draw"
    const target = gridTarget()
    gestures.handleGridPointerDown(
      pointerEvent("pointerdown", { clientX: 240, clientY: 100 }, target)
    )
    await nextTick()
    expect(gestures.createPreviewStyle.value).not.toBeNull()
    gestures.cancelGridGesture()
    expect(gestures.createPreviewStyle.value).toBeNull()
    expect(batch).not.toHaveBeenCalled()
  })
})
