import { useStorage } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed } from "vue"

export const useStudioWorkspaceStore = defineStore("studio-workspace", () => {
  const soundBrowserOpen = useStorage("yadaw.workspace.sound-browser.v1", true)
  const lowerDockOpen = useStorage("yadaw.workspace.mixer-dock.v1", true)
  const activeLowerDock = useStorage<"mixer" | "piano-roll">(
    "yadaw.workspace.lower-dock-tab.v1",
    "mixer"
  )
  const mixerDockHeight = useStorage("yadaw.workspace.mixer-dock-height.v1", 284)

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

  function toggleMixerDock(): void {
    if (mixerDockOpen.value) lowerDockOpen.value = false
    else {
      activeLowerDock.value = "mixer"
      lowerDockOpen.value = true
    }
  }

  function openPianoRollDock(): void {
    activeLowerDock.value = "piano-roll"
    lowerDockOpen.value = true
  }

  function activateLowerDock(value: "mixer" | "piano-roll"): void {
    activeLowerDock.value = value
    lowerDockOpen.value = true
  }

  function closeLowerDock(): void {
    lowerDockOpen.value = false
  }

  function setDockHeight(height: number): void {
    mixerDockHeight.value = Math.min(480, Math.max(190, Math.round(height)))
  }

  function reset(): void {
    soundBrowserOpen.value = true
    lowerDockOpen.value = true
    activeLowerDock.value = "mixer"
    mixerDockHeight.value = 284
  }

  return {
    soundBrowserOpen,
    lowerDockOpen,
    activeLowerDock,
    mixerDockOpen,
    pianoRollDockOpen,
    mixerDockHeight,
    dockStyle,
    toggleSoundBrowser,
    toggleMixerDock,
    openPianoRollDock,
    activateLowerDock,
    closeLowerDock,
    setDockHeight,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStudioWorkspaceStore, import.meta.hot))
}
