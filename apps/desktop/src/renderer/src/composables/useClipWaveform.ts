import { onScopeDispose, readonly, shallowRef, watch } from "vue"
import type { MaybeRefOrGetter } from "vue"
import { toValue } from "vue"
import type { WaveformPeakWindow } from "@yadaw/contracts"
import { useWaveformStore } from "../stores/waveform"

interface UseClipWaveformOptions {
  id: MaybeRefOrGetter<string>
  recording: MaybeRefOrGetter<boolean>
  startFrame: MaybeRefOrGetter<number>
  endFrame: MaybeRefOrGetter<number>
  pixelWidth: MaybeRefOrGetter<number>
}

export function useClipWaveform(options: UseClipWaveformOptions) {
  const store = useWaveformStore()
  const data = shallowRef<WaveformPeakWindow | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef("")
  let timer: ReturnType<typeof setTimeout> | null = null
  let poller: ReturnType<typeof setInterval> | null = null
  let generation = 0

  async function load(): Promise<void> {
    const current = ++generation
    const request = {
      id: toValue(options.id),
      startFrame: Math.max(0, Math.floor(toValue(options.startFrame))),
      endFrame: Math.max(0, Math.floor(toValue(options.endFrame))),
      maxBuckets: Math.max(1, Math.min(4_096, Math.ceil(toValue(options.pixelWidth))))
    }
    if (request.endFrame < request.startFrame) return
    loading.value = data.value === null
    try {
      const result = toValue(options.recording)
        ? await store.loadRecording(request)
        : await store.loadAsset(request)
      if (generation !== current) return
      data.value = result
      error.value = ""
    } catch (reason) {
      if (generation !== current || toValue(options.recording)) return
      error.value = reason instanceof Error ? reason.message : "Waveform unavailable"
    } finally {
      if (generation === current) loading.value = false
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void load(), 40)
  }

  watch(
    () => [
      toValue(options.id),
      toValue(options.recording),
      toValue(options.startFrame),
      toValue(options.endFrame),
      Math.ceil(toValue(options.pixelWidth))
    ],
    () => {
      generation += 1
      if (poller) clearInterval(poller)
      poller = null
      schedule()
      if (toValue(options.recording)) poller = setInterval(() => void load(), 50)
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    generation += 1
    if (timer) clearTimeout(timer)
    if (poller) clearInterval(poller)
  })

  return { data: readonly(data), loading: readonly(loading), error: readonly(error) }
}
