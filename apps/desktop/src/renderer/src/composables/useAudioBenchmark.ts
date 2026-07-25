import { readonly, shallowRef } from "vue"
import type { AudioBenchmarkReport } from "@yadaw/contracts"

export type AudioBenchmarkStatus = "idle" | "running" | "complete" | "error"

export function useAudioBenchmark() {
  const isOpen = shallowRef(false)
  const status = shallowRef<AudioBenchmarkStatus>("idle")
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
    isOpen: readonly(isOpen),
    status: readonly(status),
    report: readonly(report),
    errorMessage: readonly(errorMessage),
    open,
    close,
    run
  }
}
