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

  it("persists browser and mixer visibility", async () => {
    const workspace = useStudioWorkspaceStore()

    expect(workspace.soundBrowserOpen).toBe(true)
    expect(workspace.mixerDockOpen).toBe(true)

    workspace.toggleSoundBrowser()
    workspace.toggleMixerDock()
    await nextTick()

    expect(workspace.soundBrowserOpen).toBe(false)
    expect(workspace.mixerDockOpen).toBe(false)
    expect(localStorage.getItem("yadaw.workspace.sound-browser.v1")).toBe("false")
    expect(localStorage.getItem("yadaw.workspace.mixer-dock.v1")).toBe("false")
  })

  it("restores the default workspace state", () => {
    const workspace = useStudioWorkspaceStore()
    workspace.soundBrowserOpen = false
    workspace.mixerDockOpen = false
    workspace.mixerDockHeight = 430

    workspace.reset()

    expect(workspace.soundBrowserOpen).toBe(true)
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
