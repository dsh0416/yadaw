import { createPinia, setActivePinia } from "pinia"
import { mount } from "@vue/test-utils"
import { computed, defineComponent, h, nextTick, ref } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MidiClipState, ProjectCommand, ProjectGraphSnapshot } from "@yadaw/contracts"
import { usePianoRollStore } from "../../stores/pianoRoll"
import { createPianoRollEditing, type PianoRollEditing } from "./usePianoRollEditing"
import type { NoteGestureItem, PianoRollNoteEdit } from "./usePianoRollGestures"

const clip: MidiClipState = {
  id: "clip-1",
  sourceId: "source-1",
  trackId: "track:instrument-1",
  name: "Verse",
  startTick: 960,
  lengthTicks: 1_920,
  sourceOffsetTicks: 0,
  notes: [
    {
      id: "note-1",
      startTick: 100,
      durationTicks: 240,
      channel: 0,
      key: 60,
      velocity: 100,
      releaseVelocity: 0
    },
    {
      id: "note-2",
      startTick: 480,
      durationTicks: 120,
      channel: 1,
      key: 64,
      velocity: 90,
      releaseVelocity: 10
    }
  ],
  events: []
}

const graphSnapshot: ProjectGraphSnapshot = {
  sampleRate: 48_000,
  tracks: [{ id: "track:instrument-1", channelId: "instrument-1", sortOrder: 0 }],
  channels: [],
  audioClips: [],
  sends: [],
  plugins: [],
  midiClips: [clip],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
}

function item(noteId: string): NoteGestureItem | null {
  const note = clip.notes.find((candidate) => candidate.id === noteId)
  if (!note) return null
  return {
    clip,
    note,
    globalStartTick: clip.startTick + note.startTick - clip.sourceOffsetTicks
  }
}

function requireItem(noteId: string): NoteGestureItem {
  const value = item(noteId)
  if (!value) throw new Error(`Missing fixture note ${noteId}`)
  return value
}

describe("createPianoRollEditing", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function setup(options?: {
    selected?: NoteGestureItem[]
    visible?: NoteGestureItem[]
    previews?: Map<string, { globalStartTick: number; durationTicks: number; key: number }>
  }): {
    pianoRollStore: ReturnType<typeof usePianoRollStore>
    editing: PianoRollEditing
    batch: ReturnType<typeof vi.fn>
    commandsForEdits: ReturnType<typeof vi.fn>
    unmount: () => void
  } {
    const pianoRollStore = usePianoRollStore()
    pianoRollStore.snap = "1/16"
    const selected = options?.selected ?? [requireItem("note-1")]
    pianoRollStore.setSelectedNotes(
      selected.map(({ clip: selectedClip, note }) => ({
        clipId: selectedClip.id,
        noteId: note.id
      }))
    )
    const batch = vi.fn(async () => true)
    const commandsForEdits = vi.fn((values: PianoRollNoteEdit[]) => [
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
    let editing!: PianoRollEditing
    const wrapper = mount(
      defineComponent({
        setup() {
          editing = createPianoRollEditing({
            pianoRollStore,
            graph: ref(graphSnapshot),
            activeClip: computed(() => clip),
            visibleNotes: computed(
              () =>
                options?.visible ??
                (clip.notes.map((note) => requireItem(note.id)) as NoteGestureItem[])
            ),
            selectedItems: computed(() =>
              pianoRollStore.selectedNotes.flatMap((reference) => {
                const value = item(reference.noteId)
                return value ? [value] : []
              })
            ),
            gestureNotePreviews: computed(() => options?.previews ?? new Map()),
            batch,
            commandsForEdits
          })
          return () => h("div")
        }
      })
    )
    return {
      pianoRollStore,
      editing,
      batch,
      commandsForEdits,
      unmount: () => wrapper.unmount()
    }
  }

  it("deletes the selection grouped by clip and clears it after success", async () => {
    const { pianoRollStore, editing, batch, unmount } = setup({
      selected: [requireItem("note-1"), requireItem("note-2")]
    })
    editing.deleteSelected()
    await nextTick()
    expect(batch).toHaveBeenCalledWith([
      { type: "delete-midi-notes", clipId: "clip-1", noteIds: ["note-1", "note-2"] }
    ])
    expect(pianoRollStore.selectedNotes).toHaveLength(0)
    unmount()
  })

  it("copies, cuts, and pastes notes relative to the edit cursor", async () => {
    const { pianoRollStore, editing, batch, unmount } = setup({
      selected: [requireItem("note-1"), requireItem("note-2")]
    })
    editing.copySelected()
    expect(pianoRollStore.clipboard).toEqual([
      expect.objectContaining({ offsetTick: 0, key: 60, durationTicks: 240 }),
      expect.objectContaining({ offsetTick: 380, key: 64, durationTicks: 120 })
    ])

    pianoRollStore.editCursorTick = 2_000
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("paste-1").mockReturnValueOnce("paste-2")
    editing.paste()
    await nextTick()
    expect(batch).toHaveBeenCalled()
    const commands = batch.mock.calls[0]![0] as ProjectCommand[]
    expect(commands.some((command) => command.type === "create-midi-notes")).toBe(true)
    expect(pianoRollStore.selectedNotes).toEqual([
      { clipId: "clip-1", noteId: "paste-1" },
      { clipId: "clip-1", noteId: "paste-2" }
    ])

    batch.mockClear()
    pianoRollStore.setSelectedNotes([
      { clipId: "clip-1", noteId: "note-1" },
      { clipId: "clip-1", noteId: "note-2" }
    ])
    editing.cutSelected()
    await nextTick()
    expect(batch).toHaveBeenCalledWith([
      { type: "delete-midi-notes", clipId: "clip-1", noteIds: ["note-1", "note-2"] }
    ])
    unmount()
  })

  it("selects all visible notes and duplicates the selection by snap-aligned offset", async () => {
    const { pianoRollStore, editing, batch, unmount } = setup({
      selected: [requireItem("note-1")],
      visible: [requireItem("note-1"), requireItem("note-2")]
    })
    editing.selectAll()
    expect(pianoRollStore.selectedNotes).toHaveLength(2)

    pianoRollStore.setSelectedNotes([{ clipId: "clip-1", noteId: "note-1" }])
    vi.spyOn(crypto, "randomUUID").mockReturnValue("dup-1")
    editing.duplicateSelected()
    await nextTick()
    const commands = batch.mock.calls[0]![0] as ProjectCommand[]
    const create = commands.find((command) => command.type === "create-midi-notes")
    expect(create).toMatchObject({
      type: "create-midi-notes",
      notes: [expect.objectContaining({ id: "dup-1", key: 60 })]
    })
    unmount()
  })

  it("quantizes selected note starts when snap is enabled", async () => {
    const { pianoRollStore, editing, batch, commandsForEdits, unmount } = setup({
      selected: [requireItem("note-1")]
    })
    editing.quantizeSelected()
    await nextTick()
    expect(commandsForEdits).toHaveBeenCalledWith([
      expect.objectContaining({
        globalStartTick: 960,
        note: expect.objectContaining({ id: "note-1" })
      })
    ])
    expect(batch).toHaveBeenCalled()

    batch.mockClear()
    commandsForEdits.mockClear()
    pianoRollStore.snap = "off"
    editing.quantizeSelected()
    expect(batch).not.toHaveBeenCalled()
    unmount()
  })

  it("applies inspector fields and reports common values with gesture previews", async () => {
    const previews = new Map([
      ["clip-1:note-1", { globalStartTick: 1_100, durationTicks: 300, key: 62 }]
    ])
    const { editing, batch, commandsForEdits, unmount } = setup({
      selected: [requireItem("note-1")],
      previews
    })

    expect(editing.commonValue("start")).toBe("1100")
    expect(editing.commonValue("duration")).toBe("300")
    expect(editing.commonValue("key")).toBe("62")
    expect(editing.commonValue("channel")).toBe("1")
    expect(editing.commonValue("velocity")).toBe("100")

    editing.applyInspector("velocity", "88")
    await nextTick()
    expect(commandsForEdits).toHaveBeenCalledWith([
      expect.objectContaining({
        patch: expect.objectContaining({ velocity: 88 })
      })
    ])
    expect(batch).toHaveBeenCalled()

    batch.mockClear()
    editing.applyInspector("duration", "12")
    expect(commandsForEdits).toHaveBeenCalledWith([expect.objectContaining({ durationTicks: 12 })])

    batch.mockClear()
    editing.applyInspector("key", "200")
    expect(commandsForEdits).toHaveBeenCalledWith([
      expect.objectContaining({ patch: expect.objectContaining({ key: 127 }) })
    ])

    batch.mockClear()
    editing.applyInspector("channel", "3")
    expect(commandsForEdits).toHaveBeenCalledWith([
      expect.objectContaining({ patch: expect.objectContaining({ channel: 2 }) })
    ])

    batch.mockClear()
    editing.applyInspector("releaseVelocity", "40")
    expect(commandsForEdits).toHaveBeenCalledWith([
      expect.objectContaining({ patch: expect.objectContaining({ releaseVelocity: 40 }) })
    ])

    batch.mockClear()
    editing.applyInspector("start", "0")
    expect(commandsForEdits).toHaveBeenCalledWith([expect.objectContaining({ globalStartTick: 0 })])

    editing.applyInspector("velocity", "   ")
    editing.applyInspector("velocity", "NaN")
    unmount()
  })

  it("returns an empty common value when selected notes disagree", () => {
    const { editing, unmount } = setup({
      selected: [requireItem("note-1"), requireItem("note-2")]
    })
    expect(editing.commonValue("key")).toBe("")
    expect(editing.commonValue("velocity")).toBe("")
    unmount()
  })

  it("moves and resizes the selection from keyboard shortcuts", async () => {
    const { pianoRollStore, editing, batch, commandsForEdits, unmount } = setup({
      selected: [requireItem("note-1")]
    })

    editing.moveSelection(240, 0)
    expect(commandsForEdits).toHaveBeenCalledWith([
      expect.objectContaining({ globalStartTick: 1_300, patch: { key: 60 } })
    ])

    commandsForEdits.mockClear()
    editing.moveSelection(120, 0, true)
    expect(commandsForEdits).toHaveBeenCalledWith([expect.objectContaining({ durationTicks: 360 })])

    batch.mockClear()
    editing.handleKeydown(
      new KeyboardEvent("keydown", { code: "ArrowUp", shiftKey: true, bubbles: true })
    )
    expect(commandsForEdits).toHaveBeenCalledWith([expect.objectContaining({ patch: { key: 72 } })])

    editing.handleKeydown(new KeyboardEvent("keydown", { code: "ArrowDown", bubbles: true }))
    editing.handleKeydown(
      new KeyboardEvent("keydown", { code: "ArrowLeft", altKey: true, bubbles: true })
    )
    editing.handleKeydown(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }))
    editing.handleKeydown(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }))
    expect(pianoRollStore.selectedNotes).toHaveLength(0)

    pianoRollStore.setSelectedNotes([{ clipId: "clip-1", noteId: "note-1" }])
    editing.handleKeydown(
      new KeyboardEvent("keydown", { code: "KeyC", ctrlKey: true, bubbles: true })
    )
    expect(pianoRollStore.clipboard.length).toBeGreaterThan(0)

    editing.handleKeydown(
      new KeyboardEvent("keydown", { code: "KeyA", ctrlKey: true, bubbles: true })
    )
    expect(pianoRollStore.selectedNotes).toHaveLength(2)

    const input = document.createElement("input")
    const ignored = new KeyboardEvent("keydown", { code: "KeyC", ctrlKey: true })
    Object.defineProperty(ignored, "target", { value: input })
    editing.handleKeydown(ignored)
    unmount()
  })

  it("routes registered edit commands while mounted", () => {
    const { pianoRollStore, editing, unmount } = setup()
    const copy = vi.spyOn(editing, "copySelected")
    pianoRollStore.editorFocused = true
    expect(pianoRollStore.executeEditCommand("copy")).toBe(true)
    // Handler closes over the real function, not the spy — verify via clipboard side effect.
    pianoRollStore.clipboard = []
    pianoRollStore.setSelectedNotes([{ clipId: "clip-1", noteId: "note-1" }])
    expect(pianoRollStore.executeEditCommand("copy")).toBe(true)
    expect(pianoRollStore.clipboard).toHaveLength(1)
    expect(pianoRollStore.executeEditCommand("select-all")).toBe(true)
    expect(pianoRollStore.selectedNotes).toHaveLength(2)
    void copy
    unmount()
    expect(pianoRollStore.executeEditCommand("copy")).toBe(false)
  })
})
