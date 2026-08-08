import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { ProjectAssetSummary } from "@heron/contracts"
import { useProjectStore } from "./project"

export const useMediaBrowserStore = defineStore("media-browser", () => {
  const projectStore = useProjectStore()
  const selectedAssetId = shallowRef<string | null>(null)
  const auditioningAssetId = shallowRef<string | null>(null)
  const auditionFailed = shallowRef(false)
  let auditionTimer: ReturnType<typeof setTimeout> | null = null

  const selectedAsset = computed(() =>
    projectStore.projectAssets.find((asset) => asset.id === selectedAssetId.value)
  )

  function select(assetId: string): void {
    selectedAssetId.value = assetId
  }

  function reconcileAssets(assets: readonly ProjectAssetSummary[]): void {
    if (selectedAssetId.value && !assets.some((asset) => asset.id === selectedAssetId.value)) {
      selectedAssetId.value = null
    }
  }

  async function stopAudition(): Promise<void> {
    if (auditionTimer) clearTimeout(auditionTimer)
    auditionTimer = null
    const stoppingAssetId = auditioningAssetId.value
    if (!(await projectStore.stopAssetAudition())) {
      auditionFailed.value = true
      return
    }
    if (auditioningAssetId.value === stoppingAssetId) auditioningAssetId.value = null
  }

  async function toggleAudition(asset: ProjectAssetSummary): Promise<void> {
    if (asset.kind !== "audio") return
    if (auditioningAssetId.value === asset.id) {
      await stopAudition()
      return
    }
    if (auditioningAssetId.value) await stopAudition()
    auditionFailed.value = false
    if (!(await projectStore.startAssetAudition(asset.id))) {
      auditionFailed.value = true
      return
    }
    auditioningAssetId.value = asset.id
    const durationMs = Math.ceil((Number(asset.frameCount) / asset.sampleRate) * 1000)
    auditionTimer = setTimeout(() => void stopAudition(), Math.max(0, durationMs))
  }

  async function toggleSelectedAudition(): Promise<boolean> {
    const asset = selectedAsset.value
    if (asset?.kind !== "audio") return false
    await toggleAudition(asset)
    return true
  }

  async function reset(): Promise<void> {
    if (auditioningAssetId.value) await stopAudition()
    selectedAssetId.value = null
    auditionFailed.value = false
  }

  return {
    selectedAssetId,
    selectedAsset,
    auditioningAssetId,
    auditionFailed,
    select,
    reconcileAssets,
    toggleAudition,
    toggleSelectedAudition,
    stopAudition,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMediaBrowserStore, import.meta.hot))
}
