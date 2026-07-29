import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePianoRollStore } from "./pianoRoll"

describe("piano roll store", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("opens the explicit arrangement selection and tracks an active clip", () => {
    const store = usePianoRollStore()
    store.selectArrangementClip("clip-1")
    store.selectArrangementClip("clip-2", true)
    store.openSelection("clip-2")

    expect(store.openClipIds).toEqual(["clip-1", "clip-2"])
    expect(store.activeClipId).toBe("clip-2")
  })

  it("maintains clip-qualified multi-note selection", () => {
    const store = usePianoRollStore()
    store.selectNote({ clipId: "clip-1", noteId: "note-1" })
    store.selectNote({ clipId: "clip-2", noteId: "note-1" }, true)

    expect(store.selectedNotes).toHaveLength(2)
    expect(store.selectedNoteKeys).toEqual(new Set(["clip-1:note-1", "clip-2:note-1"]))
  })

  it("prunes deleted graph entities and falls back to the remaining active clip", () => {
    const store = usePianoRollStore()
    store.openClipIds = ["clip-1", "clip-2"]
    store.activeClipId = "clip-1"
    store.selectedNotes = [
      { clipId: "clip-1", noteId: "gone" },
      { clipId: "clip-2", noteId: "kept" }
    ]

    store.reconcile(new Set(["clip-2"]), new Set(["clip-2:kept"]))

    expect(store.openClipIds).toEqual(["clip-2"])
    expect(store.activeClipId).toBe("clip-2")
    expect(store.selectedNotes).toEqual([{ clipId: "clip-2", noteId: "kept" }])
  })

  it("clamps zoom setters to the supported ranges", () => {
    const store = usePianoRollStore()
    store.setPixelsPerQuarter(12)
    expect(store.pixelsPerQuarter).toBe(40)
    store.setPixelsPerQuarter(4_000)
    expect(store.pixelsPerQuarter).toBe(960)
    store.setPixelsPerQuarter(149.6)
    expect(store.pixelsPerQuarter).toBe(150)
    store.setRowHeight(2)
    expect(store.rowHeight).toBe(10)
    store.setRowHeight(200)
    expect(store.rowHeight).toBe(32)
  })

  it("persists view preferences and restores defaults on reset", async () => {
    const storedValues = new Map<string, string>()
    const storage = {
      get length() {
        return storedValues.size
      },
      clear: () => storedValues.clear(),
      getItem: (key: string) => storedValues.get(key) ?? null,
      key: (index: number) => [...storedValues.keys()][index] ?? null,
      removeItem: (key: string) => storedValues.delete(key),
      setItem: (key: string, value: string) => storedValues.set(key, value)
    } as Storage
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage })

    const store = usePianoRollStore()
    store.snap = "1/8"
    store.setPixelsPerQuarter(240)
    store.setRowHeight(24)
    store.showVelocityLane = false
    await nextTick()

    expect(window.localStorage.getItem("yadaw.piano-roll.snap.v1")).toBe("1/8")
    expect(window.localStorage.getItem("yadaw.piano-roll.time-zoom.v1")).toBe("240")
    expect(window.localStorage.getItem("yadaw.piano-roll.row-height.v1")).toBe("24")
    expect(window.localStorage.getItem("yadaw.piano-roll.velocity-lane.v1")).toBe("false")

    store.reset()
    expect(store.snap).toBe("1/16")
    expect(store.pixelsPerQuarter).toBe(120)
    expect(store.rowHeight).toBe(18)
    expect(store.showVelocityLane).toBe(true)
  })

  it("routes contextual Edit commands only while the editor owns focus", () => {
    const store = usePianoRollStore()
    const handler = vi.fn()
    store.registerEditCommandHandler(handler)

    expect(store.executeEditCommand("copy")).toBe(false)
    store.editorFocused = true
    expect(store.executeEditCommand("copy")).toBe(true)
    expect(handler).toHaveBeenCalledWith("copy")
  })
})
