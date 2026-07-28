import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type { CompiledAudioGraphSnapshot } from "@yadaw/contracts"

export type CompiledEffectGraphStatus = "idle" | "loading" | "ready" | "empty" | "error"

function isSamePublishedBuild(
  current: CompiledAudioGraphSnapshot | null,
  next: CompiledAudioGraphSnapshot | null
): boolean {
  if (current === next) return true
  if (!current || !next) return false
  return (
    current.buildGeneration === next.buildGeneration &&
    current.graphRevision === next.graphRevision &&
    current.sampleRate === next.sampleRate
  )
}

export const useCompiledEffectGraphStore = defineStore("compiled-effect-graph", () => {
  const isOpen = shallowRef(false)
  const status = shallowRef<CompiledEffectGraphStatus>("idle")
  const snapshot = shallowRef<CompiledAudioGraphSnapshot | null>(null)
  const errorMessage = shallowRef("")
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let requestGeneration = 0
  let refreshPromise: Promise<void> | null = null
  let refreshQueued = false

  async function refresh(): Promise<void> {
    if (!isOpen.value) return
    if (refreshPromise) {
      refreshQueued = true
      requestGeneration += 1
      return refreshPromise
    }
    const generation = ++requestGeneration
    if (!snapshot.value) status.value = "loading"
    errorMessage.value = ""
    refreshPromise = (async () => {
      try {
        const next = await window.yadaw.compiledAudioGraphSnapshot()
        if (!isOpen.value || generation !== requestGeneration) return
        if (!isSamePublishedBuild(snapshot.value, next)) snapshot.value = next
        status.value = next ? "ready" : "empty"
      } catch (reason) {
        if (!isOpen.value || generation !== requestGeneration) return
        errorMessage.value =
          reason instanceof Error ? reason.message : "The audio helper did not return a graph."
        status.value = "error"
      } finally {
        refreshPromise = null
        if (refreshQueued && isOpen.value) {
          refreshQueued = false
          void refresh()
        }
      }
    })()
    return refreshPromise
  }

  function open(): void {
    if (isOpen.value) return
    isOpen.value = true
    status.value = snapshot.value ? "ready" : "loading"
    void refresh()
    pollTimer = setInterval(() => void refresh(), 1_000)
  }

  function close(): void {
    isOpen.value = false
    requestGeneration += 1
    refreshQueued = false
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  return { isOpen, status, snapshot, errorMessage, open, close, refresh }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCompiledEffectGraphStore, import.meta.hot))
}
