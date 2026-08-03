import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type { AudioBenchmarkReport } from "@heron/contracts"
import { mutationMeta, rpcErrorMessage } from "../rpc"
import { useAudioRuntimeStore } from "./audioRuntime"

export type AudioBenchmarkStatus = "idle" | "running" | "complete" | "error"

export const useAudioBenchmarkStore = defineStore("audio-benchmark", () => {
  const isOpen = shallowRef(false)
  const status = shallowRef<AudioBenchmarkStatus>("idle")
  const audioRuntime = useAudioRuntimeStore()
  const report = shallowRef<AudioBenchmarkReport | null>(null)
  const errorMessage = shallowRef("")

  function open(): void {
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  async function run(): Promise<void> {
    if (status.value === "running") return
    status.value = "running"
    report.value = null
    errorMessage.value = ""
    try {
      const target = audioRuntime.audioHostRef
      if (!target) throw new Error("Audio host resource is unavailable.")
      const result = await window.heron.runAudioBenchmark(mutationMeta(target, "audio-benchmark"))
      if (!result.ok) {
        errorMessage.value = rpcErrorMessage(result.error)
        status.value = "error"
        return
      }
      report.value = result.value
      status.value = "complete"
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : "The audio benchmark could not be completed."
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
    run
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAudioBenchmarkStore, import.meta.hot))
}
