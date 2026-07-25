import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type { AudioBenchmarkReport } from "@yadaw/contracts"

export type AudioBenchmarkStatus = "idle" | "running" | "complete" | "error"

export const useAudioBenchmarkStore = defineStore("audio-benchmark", () => {
  const isOpen = shallowRef(false)
  const status = shallowRef<AudioBenchmarkStatus>("idle")
  const report = shallowRef<AudioBenchmarkReport | null>(null)
  const errorMessage = shallowRef("")
  let unsubscribe: (() => void) | null = null

  function open(): void {
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  function startSubscription(): void {
    unsubscribe ??= window.yadaw.subscribeAudioBenchmarkRequests(open)
  }

  function stopSubscription(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  async function run(): Promise<void> {
    if (status.value === "running") return
    status.value = "running"
    report.value = null
    errorMessage.value = ""
    try {
      report.value = await window.yadaw.runAudioBenchmark()
      status.value = "complete"
    } catch (error) {
      errorMessage.value = error instanceof Error
        ? error.message
        : "The audio benchmark could not be completed."
      status.value = "error"
    }
  }

  return {
    isOpen,
    status,
    report,
    errorMessage,
    open,
    close,
    run,
    startSubscription,
    stopSubscription
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAudioBenchmarkStore, import.meta.hot))
}
