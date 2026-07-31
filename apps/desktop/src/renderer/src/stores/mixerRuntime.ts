import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type { MixerRuntimeSnapshot } from "@yadaw/contracts"
import { meterFor as selectMeterFor } from "@yadaw/project-model"
import { useMixerMeterPolling } from "./mixer-meter-polling"

const EMPTY_RUNTIME: MixerRuntimeSnapshot = { meters: [], capturedAt: 0 }

export const useMixerRuntimeStore = defineStore("mixer-runtime", () => {
  const runtime = shallowRef<MixerRuntimeSnapshot>(structuredClone(EMPTY_RUNTIME))
  const error = shallowRef("")

  function meterFor(channelId: string) {
    return selectMeterFor(runtime.value, channelId)
  }

  async function refresh(): Promise<void> {
    try {
      runtime.value = await window.yadaw.mixerSnapshot()
    } catch {
      // Device-level errors remain owned by the audio runtime store.
    }
  }

  async function clearClips(): Promise<void> {
    runtime.value = {
      ...runtime.value,
      meters: runtime.value.meters.map((meter) => ({
        ...meter,
        heldPeak: [0, 0],
        clipped: false
      }))
    }
    try {
      runtime.value = await window.yadaw.clearMixerMeterClips()
    } catch (reason) {
      error.value =
        reason instanceof Error ? reason.message : "Unable to reset mixer clipping indicators."
    }
  }

  const polling = useMixerMeterPolling(refresh)

  function reset(): void {
    polling.stop()
    runtime.value = structuredClone(EMPTY_RUNTIME)
    error.value = ""
  }

  return {
    runtime,
    error,
    meterFor,
    refresh,
    clearClips,
    startPolling: polling.start,
    stopPolling: polling.stop,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMixerRuntimeStore, import.meta.hot))
}
