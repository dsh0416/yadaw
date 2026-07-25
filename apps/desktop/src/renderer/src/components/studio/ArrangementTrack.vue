<script setup lang="ts">
import { computed } from "vue"
import type { WaveformDisplayMode } from "@yadaw/contracts"
import type { TimelineClip } from "../../stores/transport"
import AudioClipCard from "./AudioClipCard.vue"

const props = defineProps<{
  clips: TimelineClip[]
  contentWidth: number
  pixelsPerSecond: number
  trackHeight: number
  amplitudeScale: number
  displayMode: WaveformDisplayMode
  viewportStartSeconds: number
  viewportEndSeconds: number
  selectedClipId: string | null
  liveClip: TimelineClip | null
  tempo: number
  beatsPerBar: number
  trackId: string
  trackColor: string
}>()

const emit = defineEmits<{
  seek: [seconds: number]
  selectClip: [id: string]
  waveformFrameCount: [frameCount: number, sampleRate: number]
  moveClip: [clipId: string, trackId: string, startSeconds: number]
}>()

const laneStyle = computed(() => ({
  width: `${props.contentWidth}px`,
  height: `${props.trackHeight}px`
}))
const barLines = computed(() => {
  const barDuration = 60 / props.tempo * props.beatsPerBar
  const count = Math.min(2_048, Math.ceil(props.contentWidth / props.pixelsPerSecond / barDuration))
  return Array.from({ length: count }, (_, index) => index * barDuration * props.pixelsPerSecond)
})
const displayedClips = computed(() => props.liveClip
  ? [...props.clips.filter((clip) => clip.id !== props.liveClip?.id), props.liveClip]
  : props.clips
)

function seekFromPointer(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  emit("seek", Math.max(0, (event.clientX - bounds.left) / props.pixelsPerSecond))
}
function relayWaveformFrameCount(frameCount: number, sampleRate: number): void {
  emit("waveformFrameCount", frameCount, sampleRate)
}
function moveClip(event: DragEvent): void {
  const encoded = event.dataTransfer?.getData("application/x-yadaw-clip")
  if (!encoded) return
  try {
    const value = JSON.parse(encoded) as { id: string; offsetSeconds: number }
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const startSeconds = Math.max(
      0,
      (event.clientX - bounds.left) / props.pixelsPerSecond - value.offsetSeconds
    )
    emit("moveClip", value.id, props.trackId, startSeconds)
  } catch {
    // Ignore drag payloads from outside YADAW.
  }
}
</script>

<template>
  <div
    class="track-lane"
    :style="laneStyle"
    @pointerdown="seekFromPointer"
    @dragover.prevent
    @drop.prevent="moveClip"
  >
    <i v-for="(left, index) in barLines" :key="index" class="bar-line" :style="{ left: `${left}px` }" />
    <AudioClipCard
      v-for="clip in displayedClips"
      :key="clip.id"
      :clip="clip"
      :track-color="trackColor"
      :pixels-per-second="pixelsPerSecond"
      :viewport-start-seconds="viewportStartSeconds"
      :viewport-end-seconds="viewportEndSeconds"
      :amplitude-scale="amplitudeScale"
      :display-mode="displayMode"
      :selected="clip.id === selectedClipId"
      :recording="clip.id === liveClip?.id"
      @select="emit('selectClip', $event)"
      @waveform-frame-count="relayWaveformFrameCount"
    />
    <div v-if="clips.length === 0 && !liveClip" class="empty-message">
      Press Record to capture the first clip
    </div>
  </div>
</template>

<style scoped>
.track-lane{position:relative;min-width:100%;overflow:hidden;border-bottom:1px solid var(--line-strong);background-color:var(--daw-lane);background-image:repeating-linear-gradient(0deg,transparent 0 24px,var(--daw-lane-stripe) 25px);cursor:crosshair}.bar-line{position:absolute;z-index:0;top:0;bottom:0;width:1px;background:var(--daw-grid-line);pointer-events:none}.empty-message{position:absolute;inset:0;display:grid;place-items:center;color:var(--text-faint);font-size:8px;pointer-events:none}
</style>
