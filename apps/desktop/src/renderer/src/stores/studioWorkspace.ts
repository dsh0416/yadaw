import { useStorage } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed } from "vue"

export const useStudioWorkspaceStore = defineStore("studio-workspace", () => {
  const soundBrowserOpen = useStorage("yadaw.workspace.sound-browser.v1", true)
  const mixerDockOpen = useStorage("yadaw.workspace.mixer-dock.v1", true)
  const mixerDockHeight = useStorage("yadaw.workspace.mixer-dock-height.v1", 284)

  const dockStyle = computed(() => ({
    height: `${Math.min(480, Math.max(190, mixerDockHeight.value))}px`
  }))

  function toggleSoundBrowser(): void {
    soundBrowserOpen.value = !soundBrowserOpen.value
  }

  function toggleMixerDock(): void {
    mixerDockOpen.value = !mixerDockOpen.value
  }

  function setDockHeight(height: number): void {
    mixerDockHeight.value = Math.min(480, Math.max(190, Math.round(height)))
  }

  function reset(): void {
    soundBrowserOpen.value = true
    mixerDockOpen.value = true
    mixerDockHeight.value = 284
  }

  return {
    soundBrowserOpen,
    mixerDockOpen,
    mixerDockHeight,
    dockStyle,
    toggleSoundBrowser,
    toggleMixerDock,
    setDockHeight,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStudioWorkspaceStore, import.meta.hot))
}
