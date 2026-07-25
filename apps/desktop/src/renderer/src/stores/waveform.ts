import { acceptHMRUpdate, defineStore } from "pinia"
import type { WaveformPeakWindow, WaveformWindowRequest } from "@yadaw/contracts"

const CACHE_LIMIT = 96

export const useWaveformStore = defineStore("waveform", () => {
  const cache = new Map<string, WaveformPeakWindow>()

  function cacheKey(request: WaveformWindowRequest): string {
    return `${request.id}:${request.startFrame}:${request.endFrame}:${request.maxBuckets}`
  }

  function remember(key: string, value: WaveformPeakWindow): void {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest) cache.delete(oldest)
    }
  }

  async function loadAsset(request: WaveformWindowRequest): Promise<WaveformPeakWindow> {
    const key = cacheKey(request)
    const cached = cache.get(key)
    if (cached) {
      remember(key, cached)
      return cached
    }
    const value = await window.yadaw.readAssetWaveform(request)
    remember(key, value)
    return value
  }

  function loadRecording(request: WaveformWindowRequest): Promise<WaveformPeakWindow> {
    return window.yadaw.recordingWaveformSnapshot(request)
  }

  function clear(): void {
    cache.clear()
  }

  return { loadAsset, loadRecording, clear }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWaveformStore, import.meta.hot))
}
