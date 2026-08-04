import { useStorage } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed } from "vue"

export type StudioLeftPanel = "browser" | "inspector" | null
type StoredStudioLeftPanel = Exclude<StudioLeftPanel, null> | "closed"

function initialLeftPanel(): StoredStudioLeftPanel {
  try {
    return localStorage.getItem("heron.workspace.sound-browser.v1") === "false"
      ? "closed"
      : "browser"
  } catch {
    return "browser"
  }
}

export const useStudioWorkspaceStore = defineStore("studio-workspace", () => {
  const storedLeftPanel = useStorage<StoredStudioLeftPanel>(
    "heron.workspace.left-panel.v1",
    initialLeftPanel()
  )
  const activeLeftPanel = computed<StudioLeftPanel>({
    get: () => (storedLeftPanel.value === "closed" ? null : storedLeftPanel.value),
    set: (panel) => {
      storedLeftPanel.value = panel ?? "closed"
    }
  })
  const soundBrowserOpen = computed({
    get: () => activeLeftPanel.value === "browser",
    set: (open: boolean) => {
      if (open) activeLeftPanel.value = "browser"
      else if (activeLeftPanel.value === "browser") activeLeftPanel.value = null
    }
  })
  const inspectorOpen = computed({
    get: () => activeLeftPanel.value === "inspector",
    set: (open: boolean) => {
      if (open) activeLeftPanel.value = "inspector"
      else if (activeLeftPanel.value === "inspector") activeLeftPanel.value = null
    }
  })
  const notesPanelOpen = useStorage("heron.workspace.notes-panel.v1", false)
  const activeNotesTab = useStorage<"project" | "track">("heron.workspace.notes-tab.v1", "project")
  const lowerDockOpen = useStorage("heron.workspace.mixer-dock.v1", true)
  const activeLowerDock = useStorage<"mixer" | "piano-roll">(
    "heron.workspace.lower-dock-tab.v1",
    "mixer"
  )
  const mixerDockHeight = useStorage("heron.workspace.mixer-dock-height.v1", 284)

  const mixerDockOpen = computed({
    get: () => lowerDockOpen.value && activeLowerDock.value === "mixer",
    set: (open: boolean) => {
      lowerDockOpen.value = open
      if (open) activeLowerDock.value = "mixer"
    }
  })
  const pianoRollDockOpen = computed(
    () => lowerDockOpen.value && activeLowerDock.value === "piano-roll"
  )
  const dockStyle = computed(() => ({
    height: `${Math.min(480, Math.max(190, mixerDockHeight.value))}px`
  }))

  function toggleSoundBrowser(): void {
    soundBrowserOpen.value = !soundBrowserOpen.value
  }

  function toggleInspector(): void {
    inspectorOpen.value = !inspectorOpen.value
  }

  function toggleNotesPanel(): void {
    notesPanelOpen.value = !notesPanelOpen.value
  }

  function closeNotesPanel(): void {
    notesPanelOpen.value = false
  }

  function setActiveNotesTab(tab: "project" | "track"): void {
    activeNotesTab.value = tab
  }

  function toggleMixerDock(): void {
    if (mixerDockOpen.value) lowerDockOpen.value = false
    else {
      activeLowerDock.value = "mixer"
      lowerDockOpen.value = true
    }
  }

  function togglePianoRollDock(): void {
    if (pianoRollDockOpen.value) lowerDockOpen.value = false
    else {
      activeLowerDock.value = "piano-roll"
      lowerDockOpen.value = true
    }
  }

  function openPianoRollDock(): void {
    activeLowerDock.value = "piano-roll"
    lowerDockOpen.value = true
  }

  function closeLowerDock(): void {
    lowerDockOpen.value = false
  }

  function setDockHeight(height: number): void {
    mixerDockHeight.value = Math.min(480, Math.max(190, Math.round(height)))
  }

  function reset(): void {
    activeLeftPanel.value = "browser"
    notesPanelOpen.value = false
    activeNotesTab.value = "project"
    lowerDockOpen.value = true
    activeLowerDock.value = "mixer"
    mixerDockHeight.value = 284
  }

  return {
    activeLeftPanel,
    soundBrowserOpen,
    inspectorOpen,
    notesPanelOpen,
    activeNotesTab,
    lowerDockOpen,
    activeLowerDock,
    mixerDockOpen,
    pianoRollDockOpen,
    mixerDockHeight,
    dockStyle,
    toggleSoundBrowser,
    toggleInspector,
    toggleNotesPanel,
    closeNotesPanel,
    setActiveNotesTab,
    toggleMixerDock,
    togglePianoRollDock,
    openPianoRollDock,
    closeLowerDock,
    setDockHeight,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStudioWorkspaceStore, import.meta.hot))
}
