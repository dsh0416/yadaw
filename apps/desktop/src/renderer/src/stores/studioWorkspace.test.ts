import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { beforeEach, describe, expect, it } from "vitest"
import { useStudioWorkspaceStore } from "./studioWorkspace"

const storedValues = new Map<string, string>()
const storage: Storage = {
  get length() {
    return storedValues.size
  },
  clear() {
    storedValues.clear()
  },
  getItem(key) {
    return storedValues.get(key) ?? null
  },
  key(index) {
    return [...storedValues.keys()][index] ?? null
  },
  removeItem(key) {
    storedValues.delete(key)
  },
  setItem(key, value) {
    storedValues.set(key, value)
  }
}

describe("studio workspace store", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage })
    storage.clear()
    setActivePinia(createPinia())
  })

  it("persists the active panels, right width, and mixer visibility", async () => {
    const workspace = useStudioWorkspaceStore()

    expect(workspace.activeLeftPanel).toBeNull()
    expect(workspace.inspectorOpen).toBe(false)
    expect(workspace.activeRightPanel).toBeNull()
    expect(workspace.notesPanelOpen).toBe(false)
    expect(workspace.mediaBrowserOpen).toBe(false)
    expect(workspace.mixerDockOpen).toBe(true)

    workspace.toggleInspector()
    workspace.toggleNotesPanel()
    workspace.setRightPanelWidth(390)
    workspace.setActiveNotesTab("track")
    workspace.toggleMixerDock()
    await nextTick()

    expect(workspace.activeLeftPanel).toBe("inspector")
    expect(workspace.inspectorOpen).toBe(true)
    expect(workspace.activeRightPanel).toBe("notes")
    expect(workspace.notesPanelOpen).toBe(true)
    expect(workspace.rightPanelWidth).toBe(390)
    expect(workspace.activeNotesTab).toBe("track")
    expect(workspace.mixerDockOpen).toBe(false)
    expect(localStorage.getItem("heron.workspace.left-panel.v2")).toBe("inspector")
    expect(localStorage.getItem("heron.workspace.right-panel.v1")).toBe("notes")
    expect(localStorage.getItem("heron.workspace.right-panel-width.v1")).toBe("390")
    expect(localStorage.getItem("heron.workspace.notes-tab.v1")).toBe("track")
    expect(localStorage.getItem("heron.workspace.mixer-dock.v1")).toBe("false")
  })

  it("keeps Notes and Media Browser mutually exclusive and closes the active panel", () => {
    const workspace = useStudioWorkspaceStore()

    workspace.toggleNotesPanel()
    expect(workspace.notesPanelOpen).toBe(true)
    expect(workspace.mediaBrowserOpen).toBe(false)

    workspace.toggleMediaBrowser()
    expect(workspace.notesPanelOpen).toBe(false)
    expect(workspace.mediaBrowserOpen).toBe(true)

    workspace.toggleMediaBrowser()
    expect(workspace.activeRightPanel).toBeNull()
  })

  it("clamps the persisted right-panel width to its supported range", () => {
    const workspace = useStudioWorkspaceStore()

    workspace.setRightPanelWidth(100)
    expect(workspace.rightPanelWidth).toBe(260)
    workspace.setRightPanelWidth(900)
    expect(workspace.rightPanelWidth).toBe(480)
    workspace.setRightPanelWidth(319.6)
    expect(workspace.rightPanelWidth).toBe(320)
  })

  it("restores the default workspace state", () => {
    const workspace = useStudioWorkspaceStore()
    workspace.inspectorOpen = true
    workspace.toggleMediaBrowser()
    workspace.setRightPanelWidth(460)
    workspace.activeNotesTab = "track"
    workspace.mixerDockOpen = false
    workspace.mixerDockHeight = 430

    workspace.reset()

    expect(workspace.activeLeftPanel).toBeNull()
    expect(workspace.inspectorOpen).toBe(false)
    expect(workspace.activeRightPanel).toBeNull()
    expect(workspace.rightPanelWidth).toBe(320)
    expect(workspace.activeNotesTab).toBe("project")
    expect(workspace.mixerDockOpen).toBe(true)
    expect(workspace.mixerDockHeight).toBe(284)
    expect(workspace.dockStyle).toEqual({ height: "284px" })
  })

  it("switches and closes lower-dock editors from the shared workspace state", () => {
    const workspace = useStudioWorkspaceStore()

    workspace.togglePianoRollDock()
    expect(workspace.lowerDockOpen).toBe(true)
    expect(workspace.activeLowerDock).toBe("piano-roll")
    expect(workspace.pianoRollDockOpen).toBe(true)
    expect(workspace.mixerDockOpen).toBe(false)

    workspace.togglePianoRollDock()
    expect(workspace.lowerDockOpen).toBe(false)

    workspace.toggleMixerDock()
    expect(workspace.lowerDockOpen).toBe(true)
    expect(workspace.activeLowerDock).toBe("mixer")
    expect(workspace.mixerDockOpen).toBe(true)
  })
})
