import { useIntervalFn } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { TransportLoopRange, TransportSnapshot } from "@heron/contracts"
import type { ProjectAssetSummary as Asset } from "@heron/contracts"
import { projectContentEndSeconds } from "@heron/project-model"
import { mutationMeta, readMeta, rpcErrorMessage } from "../rpc"
import { tickToSeconds } from "../utils/tempoMap"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useMixerStore } from "./mixer"
import { usePluginStore } from "./plugins"

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
  projectSampleRate: number
  startFrame: number
  sourceOffsetFrames: number
  lengthFrames: number
  sourceLengthFrames: number
  fadeInFrames: number
  fadeOutFrames: number
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
      sampleRate: asset.sampleRate,
      projectSampleRate: asset.sampleRate,
      startFrame: Math.round(cursor * asset.sampleRate),
      sourceOffsetFrames: 0,
      lengthFrames: Number(asset.frameCount),
      sourceLengthFrames: Number(asset.frameCount),
      fadeInFrames: 0,
      fadeOutFrames: 0
    }
    cursor = clip.endSeconds
    return clip
  })
}

const EMPTY_TRANSPORT: TransportSnapshot = {
  state: "stopped",
  positionFrames: 0,
  sampleRate: 48_000,
  loopEnabled: false,
  loopRange: null
}

export const useTransportStore = defineStore("transport", () => {
  const mixerStore = useMixerStore()
  const pluginStore = usePluginStore()
  const audioRuntimeStore = useAudioRuntimeStore()
  const snapshot = shallowRef<TransportSnapshot>({ ...EMPTY_TRANSPORT })
  const selectedClipId = shallowRef<string | null>(null)
  const countInEnabled = shallowRef(false)
  const loading = shallowRef(false)
  const error = shallowRef("")
  let commandTail: Promise<void> = Promise.resolve()
  let requestGeneration = 0
  let pendingSeekFrames: number | null = null
  let seekFlush: Promise<void> | null = null

  const clips = computed<TimelineClip[]>(() =>
    mixerStore.graph.audioClips.map((clip) => {
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
        sampleRate: clip.assetSampleRate,
        projectSampleRate: sampleRate,
        startFrame: clip.startFrame,
        sourceOffsetFrames: clip.sourceOffsetFrames,
        lengthFrames: clip.lengthFrames,
        sourceLengthFrames: clip.sourceLengthFrames,
        fadeInFrames: clip.fadeInFrames,
        fadeOutFrames: clip.fadeOutFrames
      }
    })
  )
  const playheadSeconds = computed(() =>
    snapshot.value.sampleRate > 0 ? snapshot.value.positionFrames / snapshot.value.sampleRate : 0
  )
  const countingIn = computed(() => snapshot.value.state === "counting-in")
  const playing = computed(() => snapshot.value.state === "playing")
  const recording = computed(() => snapshot.value.state === "recording")
  const loopEnabled = computed(() => snapshot.value.loopEnabled)
  const loopRange = computed(() => snapshot.value.loopRange)
  const contentEndSeconds = computed(() => projectContentEndSeconds(mixerStore.graph))
  const timelineDurationSeconds = computed(() =>
    Math.max(MINIMUM_TIMELINE_SECONDS, contentEndSeconds.value + TIMELINE_TAIL_SECONDS)
  )
  // Mirror the engine's auto-stop window: finite plugin tails extend playback
  // past the content end, and any plugin with an unbounded tail (`null`)
  // disables auto-stop entirely, so the playhead never parks at the end.
  const autoStopEndSeconds = computed<number | null>(() => {
    let tailSamples = 0
    for (const instance of mixerStore.graph.plugins) {
      const tail = pluginStore.runtime[instance.id]?.tailSamples
      if (tail === null) return null
      tailSamples += tail ?? 0
    }
    const sampleRate = mixerStore.graph.sampleRate
    return contentEndSeconds.value + (sampleRate > 0 ? tailSamples / sampleRate : 0)
  })
  const canPlay = computed(
    () =>
      clips.value.length > 0 ||
      mixerStore.graph.midiClips.length > 0 ||
      (mixerStore.metronome !== null && !mixerStore.metronome.muted)
  )

  function command(value: Parameters<typeof window.heron.transportCommand>[1]): Promise<void> {
    const generation = ++requestGeneration
    const result = commandTail.then(async () => {
      const target = audioRuntimeStore.transportRef
      if (!target) return
      const next = await window.heron.transportCommand(
        mutationMeta(target, `transport-${value.type}`, audioRuntimeStore.transportRevision),
        value
      )
      if (!next.ok) {
        error.value = rpcErrorMessage(next.error)
        return
      }
      if (generation >= requestGeneration) snapshot.value = next.value
      if (next.resourceRevision !== undefined) {
        audioRuntimeStore.advanceTransportRevision(next.resourceRevision)
      }
      error.value = ""
    })
    commandTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async function refresh(): Promise<void> {
    const generation = ++requestGeneration
    const target = audioRuntimeStore.transportRef
    if (!target) {
      if (generation === requestGeneration) snapshot.value = { ...EMPTY_TRANSPORT }
      return
    }
    const next = await window.heron.transportSnapshot(readMeta(target))
    if (!next.ok) return
    if (generation === requestGeneration) snapshot.value = next.value
    if (next.resourceRevision !== undefined) {
      audioRuntimeStore.advanceTransportRevision(next.resourceRevision)
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
    if (!canPlay.value || playing.value || countingIn.value || recording.value || loading.value)
      return
    loading.value = true
    try {
      // Engine auto-stop leaves the playhead at the end of the content plus any
      // finite plugin tail; restart from zero so Play after song-end is not a
      // no-op even before the host applies Play. When Cycle is enabled, restart
      // from the cycle start instead. A playhead paused inside the tail window
      // keeps its position so the decaying tail can play out.
      const autoStopEnd = autoStopEndSeconds.value
      if (
        contentEndSeconds.value > 0 &&
        autoStopEnd !== null &&
        playheadSeconds.value >= autoStopEnd
      ) {
        const restartSeconds =
          loopEnabled.value && loopRange.value
            ? tickToSeconds(mixerStore.graph.tempoMap, loopRange.value.startTick)
            : 0
        await command({
          type: "seek",
          positionFrames: Math.round(restartSeconds * mixerStore.graph.sampleRate)
        })
      }
      await command({ type: "play" })
    } finally {
      loading.value = false
    }
  }

  function stop(): Promise<void> {
    return command({ type: "pause" })
  }

  function toggle(): Promise<void> | void {
    if (countingIn.value || recording.value) return
    if (playing.value) return command({ type: "pause" })
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

  function toggleCountIn(): void {
    countInEnabled.value = !countInEnabled.value
  }

  function setLoop(enabled: boolean, range: TransportLoopRange | null): Promise<void> {
    return command({ type: "set-loop", enabled, range })
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
    countInEnabled.value = false
    error.value = ""
  }

  return {
    snapshot,
    clips,
    playheadSeconds,
    selectedClipId,
    countInEnabled,
    countingIn,
    playing,
    recording,
    loopEnabled,
    loopRange,
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
    toggleCountIn,
    setLoop,
    selectClip,
    selectAndRevealClip,
    clearSelection,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTransportStore, import.meta.hot))
}
