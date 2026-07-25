import { useStorage } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed } from "vue"

export type StudioWorkspaceMode = "arrangement" | "mixer"

export const useStudioWorkspaceStore = defineStore("studio-workspace", () => {
  const mode = useStorage<StudioWorkspaceMode>("yadaw.workspace.mode.v1", "arrangement")
  const mixerDockOpen = useStorage("yadaw.workspace.mixer-dock.v1", true)
  const mixerDockHeight = useStorage("yadaw.workspace.mixer-dock-height.v1", 284)

  const dockStyle = computed(() => ({
    height: `${Math.min(480, Math.max(190, mixerDockHeight.value))}px`
  }))

  function showArrangement(): void {
    mode.value = "arrangement"
  }

  function showMixer(): void {
    mode.value = "mixer"
  }

  function toggleMixerDock(): void {
    mixerDockOpen.value = !mixerDockOpen.value
  }

  function setDockHeight(height: number): void {
    mixerDockHeight.value = Math.min(480, Math.max(190, Math.round(height)))
  }

  function reset(): void {
    mode.value = "arrangement"
    mixerDockOpen.value = true
    mixerDockHeight.value = 284
  }

  return {
    mode,
    mixerDockOpen,
    mixerDockHeight,
    dockStyle,
    showArrangement,
    showMixer,
    toggleMixerDock,
    setDockHeight,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStudioWorkspaceStore, import.meta.hot))
}
