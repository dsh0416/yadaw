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

  it("persists the active left panel, notes, and mixer visibility", async () => {
    const workspace = useStudioWorkspaceStore()

    expect(workspace.activeLeftPanel).toBe("browser")
    expect(workspace.soundBrowserOpen).toBe(true)
    expect(workspace.inspectorOpen).toBe(false)
    expect(workspace.notesPanelOpen).toBe(false)
    expect(workspace.mixerDockOpen).toBe(true)

    workspace.toggleInspector()
    workspace.toggleNotesPanel()
    workspace.setActiveNotesTab("track")
    workspace.toggleMixerDock()
    await nextTick()

    expect(workspace.activeLeftPanel).toBe("inspector")
    expect(workspace.soundBrowserOpen).toBe(false)
    expect(workspace.inspectorOpen).toBe(true)
    expect(workspace.notesPanelOpen).toBe(true)
    expect(workspace.activeNotesTab).toBe("track")
    expect(workspace.mixerDockOpen).toBe(false)
    expect(localStorage.getItem("heron.workspace.left-panel.v1")).toBe("inspector")
    expect(localStorage.getItem("heron.workspace.notes-panel.v1")).toBe("true")
    expect(localStorage.getItem("heron.workspace.notes-tab.v1")).toBe("track")
    expect(localStorage.getItem("heron.workspace.mixer-dock.v1")).toBe("false")
  })

  it("keeps Library and Inspector mutually exclusive and closes the active panel", () => {
    const workspace = useStudioWorkspaceStore()

    workspace.toggleInspector()
    expect(workspace.activeLeftPanel).toBe("inspector")
    expect(workspace.soundBrowserOpen).toBe(false)

    workspace.toggleSoundBrowser()
    expect(workspace.activeLeftPanel).toBe("browser")
    expect(workspace.inspectorOpen).toBe(false)

    workspace.toggleSoundBrowser()
    expect(workspace.activeLeftPanel).toBeNull()
    expect(workspace.soundBrowserOpen).toBe(false)
    expect(workspace.inspectorOpen).toBe(false)
  })

  it("migrates the legacy closed Sound Browser preference", () => {
    localStorage.setItem("heron.workspace.sound-browser.v1", "false")

    const workspace = useStudioWorkspaceStore()

    expect(workspace.activeLeftPanel).toBeNull()
    expect(workspace.soundBrowserOpen).toBe(false)
  })

  it("restores the default workspace state", () => {
    const workspace = useStudioWorkspaceStore()
    workspace.soundBrowserOpen = false
    workspace.inspectorOpen = true
    workspace.notesPanelOpen = true
    workspace.activeNotesTab = "track"
    workspace.mixerDockOpen = false
    workspace.mixerDockHeight = 430

    workspace.reset()

    expect(workspace.activeLeftPanel).toBe("browser")
    expect(workspace.soundBrowserOpen).toBe(true)
    expect(workspace.inspectorOpen).toBe(false)
    expect(workspace.notesPanelOpen).toBe(false)
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
