import { defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { Asset } from "@yadaw/project-db/schema"
import { useProjectStore } from "./project"

const MINIMUM_TIMELINE_SECONDS = 8
const TIMELINE_TAIL_SECONDS = 2

export interface TimelineClip {
  id: string
  assetId: string
  name: string
  startSeconds: number
  durationSeconds: number
  endSeconds: number
  channels: number
  sampleRate: number
}

function assetDuration(asset: Asset): number {
  if (asset.sampleRate <= 0) return 0
  return Number(asset.frameCount) / asset.sampleRate
}

export function assetsToTimelineClips(assets: Asset[]): TimelineClip[] {
  let cursor = 0
  return assets.map((asset) => {
    const durationSeconds = Math.max(0, assetDuration(asset))
    const clip: TimelineClip = {
      id: asset.id,
      assetId: asset.id,
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

export const useTransportStore = defineStore("transport", () => {
  const projectStore = useProjectStore()
  const playheadSeconds = shallowRef(0)
  const selectedClipId = shallowRef<string | null>(null)
  const playing = shallowRef(false)
  const loading = shallowRef(false)
  const error = shallowRef("")

  let context: AudioContext | null = null
  let animationFrame = 0
  let playbackGeneration = 0
  let playbackStartedAt = 0
  let playbackOrigin = 0
  const decodedAssets = new Map<string, AudioBuffer>()
  const sources = new Set<AudioBufferSourceNode>()

  const clips = computed(() => assetsToTimelineClips(projectStore.projectAssets))
  const contentEndSeconds = computed(() => clips.value.at(-1)?.endSeconds ?? 0)
  const timelineDurationSeconds = computed(() =>
    Math.max(MINIMUM_TIMELINE_SECONDS, contentEndSeconds.value + TIMELINE_TAIL_SECONDS)
  )
  const canPlay = computed(() => clips.value.length > 0 && !loading.value)

  function ensureContext(): AudioContext {
    context ??= new AudioContext()
    return context
  }

  async function decodeAsset(clip: TimelineClip, audioContext: AudioContext): Promise<AudioBuffer> {
    const cached = decodedAssets.get(clip.assetId)
    if (cached) return cached
    const bytes = await window.yadaw.readAssetAudio(clip.assetId)
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    const decoded = await audioContext.decodeAudioData(copy.buffer)
    decodedAssets.set(clip.assetId, decoded)
    return decoded
  }

  function cancelScheduledSources(): void {
    for (const source of sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // A source that already ended does not need any further cleanup.
      }
      source.disconnect()
    }
    sources.clear()
  }

  function cancelAnimation(): void {
    if (animationFrame) cancelAnimationFrame(animationFrame)
    animationFrame = 0
  }

  function updatePlayhead(): void {
    if (!playing.value || !context) return
    playheadSeconds.value = Math.min(
      contentEndSeconds.value,
      playbackOrigin + context.currentTime - playbackStartedAt
    )
    if (playheadSeconds.value >= contentEndSeconds.value) {
      stop()
      return
    }
    animationFrame = requestAnimationFrame(updatePlayhead)
  }

  function stop(): void {
    playbackGeneration += 1
    if (playing.value && context) {
      playheadSeconds.value = Math.min(
        contentEndSeconds.value,
        playbackOrigin + context.currentTime - playbackStartedAt
      )
    }
    playing.value = false
    loading.value = false
    cancelAnimation()
    cancelScheduledSources()
  }

  async function play(): Promise<void> {
    if (playing.value || loading.value || clips.value.length === 0) return
    if (playheadSeconds.value >= contentEndSeconds.value) playheadSeconds.value = 0

    const generation = ++playbackGeneration
    const startSeconds = playheadSeconds.value
    loading.value = true
    error.value = ""

    try {
      const audioContext = ensureContext()
      await audioContext.resume()
      const playable = clips.value.filter((clip) => clip.endSeconds > startSeconds)
      const buffers = await Promise.all(
        playable.map(async (clip) => ({ clip, buffer: await decodeAsset(clip, audioContext) }))
      )
      if (generation !== playbackGeneration) return

      playbackStartedAt = audioContext.currentTime
      playbackOrigin = startSeconds
      for (const { clip, buffer } of buffers) {
        const source = audioContext.createBufferSource()
        const offset = Math.max(0, startSeconds - clip.startSeconds)
        const when = audioContext.currentTime + Math.max(0, clip.startSeconds - startSeconds)
        source.buffer = buffer
        source.connect(audioContext.destination)
        source.onended = () => {
          source.disconnect()
          sources.delete(source)
        }
        sources.add(source)
        source.start(when, offset)
      }
      loading.value = false
      playing.value = true
      animationFrame = requestAnimationFrame(updatePlayhead)
    } catch (reason) {
      if (generation !== playbackGeneration) return
      loading.value = false
      playing.value = false
      error.value = reason instanceof Error ? reason.message : "Unable to play project audio."
      cancelScheduledSources()
    }
  }

  function toggle(): Promise<void> | void {
    if (playing.value || loading.value) {
      stop()
      return
    }
    return play()
  }

  function seek(seconds: number): void {
    const wasPlaying = playing.value
    stop()
    playheadSeconds.value = Math.min(
      timelineDurationSeconds.value,
      Math.max(0, Number.isFinite(seconds) ? seconds : 0)
    )
    if (wasPlaying && playheadSeconds.value < contentEndSeconds.value) void play()
  }

  function goToStart(): void {
    stop()
    playheadSeconds.value = 0
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
    stop()
    playheadSeconds.value = 0
    selectedClipId.value = null
    error.value = ""
    decodedAssets.clear()
    if (context) void context.close()
    context = null
  }

  return {
    clips,
    playheadSeconds,
    selectedClipId,
    playing,
    loading,
    error,
    contentEndSeconds,
    timelineDurationSeconds,
    canPlay,
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
