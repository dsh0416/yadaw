import { acceptHMRUpdate, defineStore } from "pinia"
import { ref } from "vue"
import type { NativeEngineInfo } from "@yadaw/contracts"
import { readMeta, rpcErrorMessage } from "../rpc"
import { useProjectStore } from "./project"

const previewSamples = [-0.5, 0.25, 1]

export const useEngineStore = defineStore("engine", () => {
  const nativeInfo = ref<NativeEngineInfo>()
  const peak = ref<number>()
  const projectStore = useProjectStore()
  const error = ref<string>()
  const initialized = ref(false)

  async function initialize(): Promise<void> {
    if (initialized.value) {
      return
    }

    initialized.value = true
    try {
      const target = projectStore.offlineWorkerRef
      if (!target) return
      const result = await window.yadaw.engineInfo(readMeta(target))
      if (!result.ok) {
        error.value = rpcErrorMessage(result.error)
        return
      }
      nativeInfo.value = result.value
      error.value = undefined
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Native engine unavailable"
    }
  }

  async function runPreview(gain: number): Promise<void> {
    try {
      const target = projectStore.offlineWorkerRef
      if (!target) return
      const result = await window.yadaw.processGain(readMeta(target), {
        samples: previewSamples,
        gain
      })
      if (!result.ok) {
        error.value = rpcErrorMessage(result.error)
        return
      }
      peak.value = result.value.peak
      error.value = undefined
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Native preview failed"
    }
  }

  return { nativeInfo, peak, error, initialize, runPreview }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useEngineStore, import.meta.hot))
}
