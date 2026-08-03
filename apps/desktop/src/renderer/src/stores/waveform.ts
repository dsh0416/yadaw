import { acceptHMRUpdate, defineStore } from "pinia"
import type { WaveformPeakWindow, WaveformWindowRequest } from "@heron/contracts"
import { readMeta, rpcErrorMessage } from "../rpc"
import { useRecordingStore } from "./recording"
import { useProjectStore } from "./project"

const CACHE_LIMIT = 96

export const useWaveformStore = defineStore("waveform", () => {
  const cache = new Map<string, WaveformPeakWindow>()
  const recordingStore = useRecordingStore()
  const projectStore = useProjectStore()

  function cacheKey(request: WaveformWindowRequest): string {
    return `${request.id}:${request.startFrame}:${request.endFrame}:${request.maxBuckets}`
  }

  function remember(key: string, value: WaveformPeakWindow): void {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
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
    const target = projectStore.projectRef
    if (!target) throw new Error("Project resource is unavailable.")
    const result = await window.heron.readAssetWaveform(readMeta(target), request)
    if (!result.ok) throw new Error(rpcErrorMessage(result.error))
    remember(key, result.value)
    return result.value
  }

  async function loadRecording(request: WaveformWindowRequest): Promise<WaveformPeakWindow> {
    const recording = recordingStore.resource
    if (!recording || recording.session.id !== request.id) {
      throw new Error("Recording resource is unavailable.")
    }
    const result = await window.heron.recordingWaveformSnapshot(
      readMeta(recording.recording),
      request
    )
    if (!result.ok) throw new Error(rpcErrorMessage(result.error))
    return result.value
  }

  function clear(): void {
    cache.clear()
  }

  return { loadAsset, loadRecording, clear }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWaveformStore, import.meta.hot))
}
