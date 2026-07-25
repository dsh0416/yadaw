import { acceptHMRUpdate, defineStore } from "pinia"
import { ref } from "vue"
import type { NativeEngineInfo } from "@yadaw/contracts"

const previewSamples = [-0.5, 0.25, 1]

export const useEngineStore = defineStore("engine", () => {
  const nativeInfo = ref<NativeEngineInfo>()
  const peak = ref<number>()
  const error = ref<string>()
  const initialized = ref(false)

  async function initialize(): Promise<void> {
    if (initialized.value) {
      return
    }

    initialized.value = true
    try {
      nativeInfo.value = await window.yadaw.engineInfo()
      error.value = undefined
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Native engine unavailable"
    }
  }

  async function runPreview(gain: number): Promise<void> {
    try {
      const result = await window.yadaw.processGain({ samples: previewSamples, gain })
      peak.value = result.peak
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
