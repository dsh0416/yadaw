import { useIntervalFn } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { TransportSnapshot } from "@yadaw/contracts"
import type { ProjectAssetSummary as Asset } from "@yadaw/contracts"
import { useMixerStore } from "./mixer"

const MINIMUM_TIMELINE_SECONDS = 8
const TIMELINE_TAIL_SECONDS = 2

export interface TimelineClip {
  id: string
  assetId: string
  trackId: string
  name: string
  startSeconds: number
  durationSeconds: number
  endSeconds: number
  channels: number
  sampleRate: number
}

export function assetsToTimelineClips(assets: Asset[]): TimelineClip[] {
  let cursor = 0
  return assets.map((asset) => {
    const durationSeconds = asset.sampleRate > 0 ? Number(asset.frameCount) / asset.sampleRate : 0
    const clip: TimelineClip = {
      id: asset.id,
      assetId: asset.id,
      trackId: "audio-1",
      name: asset.name.replace(/\.bwf$/i, ""),
      startSeconds: cursor,
      durationSeconds,
      endSeconds: cursor + durationSeconds,
      channels: asset.channels,
      sampleRate: asset.sampleRate
    }
    cursor = clip.endSeconds
    return clip
  })
}

const EMPTY_TRANSPORT: TransportSnapshot = {
  state: "stopped",
  positionFrames: 0,
  sampleRate: 48_000
}

export const useTransportStore = defineStore("transport", () => {
  const mixerStore = useMixerStore()
  const snapshot = shallowRef<TransportSnapshot>({ ...EMPTY_TRANSPORT })
  const selectedClipId = shallowRef<string | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef("")
  let commandTail: Promise<void> = Promise.resolve()
  let requestGeneration = 0
  let pendingSeekFrames: number | null = null
  let seekFlush: Promise<void> | null = null

  const clips = computed<TimelineClip[]>(() =>
    mixerStore.graph.clips.map((clip) => {
      const sampleRate = mixerStore.graph.sampleRate
      const startSeconds = clip.startFrame / sampleRate
      const durationSeconds = clip.lengthFrames / sampleRate
      return {
        id: clip.id,
        assetId: clip.assetId,
        trackId: clip.trackId,
        name: clip.name,
        startSeconds,
        durationSeconds,
        endSeconds: startSeconds + durationSeconds,
        channels: clip.assetChannels,
        sampleRate: clip.assetSampleRate
      }
    })
  )
  const playheadSeconds = computed(() =>
    snapshot.value.sampleRate > 0 ? snapshot.value.positionFrames / snapshot.value.sampleRate : 0
  )
  const playing = computed(() => snapshot.value.state === "playing")
  const recording = computed(() => snapshot.value.state === "recording")
  const contentEndSeconds = computed(() =>
    clips.value.reduce((latest, clip) => Math.max(latest, clip.endSeconds), 0)
  )
  const timelineDurationSeconds = computed(() =>
    Math.max(MINIMUM_TIMELINE_SECONDS, contentEndSeconds.value + TIMELINE_TAIL_SECONDS)
  )
  const canPlay = computed(
    () =>
      (clips.value.length > 0 || (mixerStore.metronome !== null && !mixerStore.metronome.muted)) &&
      !loading.value
  )

  function command(value: Parameters<typeof window.yadaw.transportCommand>[0]): Promise<void> {
    const generation = ++requestGeneration
    const result = commandTail.then(async () => {
      try {
        const next = await window.yadaw.transportCommand(value)
        if (generation >= requestGeneration) snapshot.value = next
        error.value = ""
      } catch (reason) {
        error.value = reason instanceof Error ? reason.message : "Transport command failed."
      }
    })
    commandTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async function refresh(): Promise<void> {
    const generation = ++requestGeneration
    try {
      const next = await window.yadaw.transportSnapshot()
      if (generation === requestGeneration) snapshot.value = next
    } catch {
      // Existing audio runtime state owns device-level errors.
    }
  }

  const polling = useIntervalFn(() => void refresh(), 33, { immediate: false })

  function startPolling(): void {
    void refresh()
    polling.resume()
  }

  function stopPolling(): void {
    polling.pause()
  }

  async function play(): Promise<void> {
    if (!canPlay.value || playing.value) return
    loading.value = true
    try {
      await command({ type: "play" })
    } finally {
      loading.value = false
    }
  }

  function stop(): Promise<void> {
    return command({ type: "pause" })
  }

  function toggle(): Promise<void> | void {
    if (playing.value || recording.value) return command({ type: "pause" })
    return play()
  }

  function seek(seconds: number): void {
    const safeSeconds = Math.min(
      timelineDurationSeconds.value,
      Math.max(0, Number.isFinite(seconds) ? seconds : 0)
    )
    pendingSeekFrames = Math.round(safeSeconds * mixerStore.graph.sampleRate)
    if (!seekFlush) {
      seekFlush = Promise.resolve().then(async () => {
        const positionFrames = pendingSeekFrames
        pendingSeekFrames = null
        seekFlush = null
        if (positionFrames !== null) await command({ type: "seek", positionFrames })
      })
    }
  }

  function goToStart(): Promise<void> {
    return command({ type: "seek", positionFrames: 0 })
  }

  function selectClip(id: string): void {
    selectedClipId.value = id
  }

  function selectAndRevealClip(id: string): void {
    selectedClipId.value = id
    const clip = clips.value.find((candidate) => candidate.id === id)
    if (clip) seek(clip.startSeconds)
  }

  function clearSelection(): void {
    selectedClipId.value = null
  }

  function reset(): void {
    stopPolling()
    snapshot.value = { ...EMPTY_TRANSPORT }
    selectedClipId.value = null
    error.value = ""
  }

  return {
    snapshot,
    clips,
    playheadSeconds,
    selectedClipId,
    playing,
    recording,
    loading,
    error,
    contentEndSeconds,
    timelineDurationSeconds,
    canPlay,
    refresh,
    startPolling,
    stopPolling,
    play,
    stop,
    toggle,
    seek,
    goToStart,
    selectClip,
    selectAndRevealClip,
    clearSelection,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTransportStore, import.meta.hot))
}
