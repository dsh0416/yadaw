import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type {
  ApplicationCaptureSnapshot,
  ApplicationCaptureTargetDescriptor
} from "@heron/contracts"
import { readMeta } from "../rpc"
import { useAudioRuntimeStore } from "./audioRuntime"

export const useApplicationCaptureStore = defineStore("application-capture", () => {
  const audioRuntime = useAudioRuntimeStore()
  const targets = shallowRef<ApplicationCaptureTargetDescriptor[]>([])
  const snapshots = shallowRef<ApplicationCaptureSnapshot[]>([])
  const loading = shallowRef(false)
  const error = shallowRef<string | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null
  let pollingConsumers = 0

  const capturing = computed(() => snapshots.value.filter((item) => item.status === "capturing"))

  async function refresh(): Promise<void> {
    const host = audioRuntime.audioHostRef
    if (!host || loading.value) return
    loading.value = true
    try {
      const [targetResult, snapshotResult] = await Promise.all([
        window.heron.listApplicationCaptureTargets(readMeta(host)),
        window.heron.applicationCaptureSnapshot(readMeta(host))
      ])
      if (!targetResult.ok) throw new Error(targetResult.error.code)
      if (!snapshotResult.ok) throw new Error(snapshotResult.error.code)
      targets.value = targetResult.value
      snapshots.value = snapshotResult.value
      error.value = null
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  function startPolling(): void {
    pollingConsumers += 1
    if (timer) return
    void refresh()
    timer = setInterval(() => void refresh(), 1_000)
  }

  function stopPolling(): void {
    pollingConsumers = Math.max(0, pollingConsumers - 1)
    if (pollingConsumers > 0) return
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return { targets, snapshots, capturing, loading, error, refresh, startPolling, stopPolling }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useApplicationCaptureStore, import.meta.hot))
}
