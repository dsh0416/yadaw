import { useStorage } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed } from "vue"

export type StudioLeftPanel = "inspector" | null
export type StudioRightPanel = "notes" | "media-browser" | null
type StoredStudioLeftPanel = Exclude<StudioLeftPanel, null> | "closed"
type StoredStudioRightPanel = Exclude<StudioRightPanel, null> | "closed"

export const useStudioWorkspaceStore = defineStore("studio-workspace", () => {
  const storedLeftPanel = useStorage<StoredStudioLeftPanel>(
    "heron.workspace.left-panel.v2",
    "closed"
  )
  const activeLeftPanel = computed<StudioLeftPanel>({
    get: () => (storedLeftPanel.value === "closed" ? null : storedLeftPanel.value),
    set: (panel) => {
      storedLeftPanel.value = panel ?? "closed"
    }
  })
  const inspectorOpen = computed({
    get: () => activeLeftPanel.value === "inspector",
    set: (open: boolean) => {
      if (open) activeLeftPanel.value = "inspector"
      else if (activeLeftPanel.value === "inspector") activeLeftPanel.value = null
    }
  })
  const storedRightPanel = useStorage<StoredStudioRightPanel>(
    "heron.workspace.right-panel.v1",
    "closed"
  )
  const activeRightPanel = computed<StudioRightPanel>({
    get: () => (storedRightPanel.value === "closed" ? null : storedRightPanel.value),
    set: (panel) => {
      storedRightPanel.value = panel ?? "closed"
    }
  })
  const notesPanelOpen = computed(() => activeRightPanel.value === "notes")
  const mediaBrowserOpen = computed(() => activeRightPanel.value === "media-browser")
  const rightPanelWidth = useStorage("heron.workspace.right-panel-width.v1", 320)
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

  function toggleInspector(): void {
    inspectorOpen.value = !inspectorOpen.value
  }

  function toggleNotesPanel(): void {
    activeRightPanel.value = notesPanelOpen.value ? null : "notes"
  }

  function closeNotesPanel(): void {
    if (notesPanelOpen.value) activeRightPanel.value = null
  }

  function toggleMediaBrowser(): void {
    activeRightPanel.value = mediaBrowserOpen.value ? null : "media-browser"
  }

  function closeRightPanel(): void {
    activeRightPanel.value = null
  }

  function setRightPanelWidth(width: number): void {
    rightPanelWidth.value = Math.min(480, Math.max(260, Math.round(width)))
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
    activeLeftPanel.value = null
    activeRightPanel.value = null
    rightPanelWidth.value = 320
    activeNotesTab.value = "project"
    lowerDockOpen.value = true
    activeLowerDock.value = "mixer"
    mixerDockHeight.value = 284
  }

  return {
    activeLeftPanel,
    inspectorOpen,
    activeRightPanel,
    notesPanelOpen,
    mediaBrowserOpen,
    rightPanelWidth,
    activeNotesTab,
    lowerDockOpen,
    activeLowerDock,
    mixerDockOpen,
    pianoRollDockOpen,
    mixerDockHeight,
    dockStyle,
    toggleInspector,
    toggleNotesPanel,
    closeNotesPanel,
    toggleMediaBrowser,
    closeRightPanel,
    setRightPanelWidth,
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
