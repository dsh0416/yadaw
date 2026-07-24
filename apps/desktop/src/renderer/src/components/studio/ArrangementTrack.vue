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
  playheadSeconds: number
  selectedClipId: string | null
  liveClip: TimelineClip | null
  tempo: number
  beatsPerBar: number
}>()

const emit = defineEmits<{
  seek: [seconds: number]
  selectClip: [id: string]
  waveformFrameCount: [frameCount: number, sampleRate: number]
}>()

const laneStyle = computed(() => ({
  width: `${props.contentWidth}px`,
  height: `${props.trackHeight}px`
}))
const playheadStyle = computed(() => ({
  left: `${props.playheadSeconds * props.pixelsPerSecond}px`
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
</script>

<template>
  <div class="track-lane" :style="laneStyle" @pointerdown="seekFromPointer">
    <i v-for="(left, index) in barLines" :key="index" class="bar-line" :style="{ left: `${left}px` }" />
    <div class="playhead" :style="playheadStyle" aria-hidden="true"><span /></div>
    <AudioClipCard
      v-for="clip in displayedClips"
      :key="clip.id"
      :clip="clip"
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
.track-lane{position:relative;min-width:100%;overflow:hidden;border-bottom:1px solid var(--line-strong);background-color:#0c111a;background-image:repeating-linear-gradient(0deg,transparent 0 24px,#17202c 25px);cursor:crosshair}.bar-line{position:absolute;z-index:0;top:0;bottom:0;width:1px;background:#222c3b;pointer-events:none}.playhead{position:absolute;z-index:8;top:0;bottom:0;width:1px;background:#ff6577;box-shadow:0 0 8px #ff657788;pointer-events:none}.playhead span{position:absolute;top:0;left:-4px;width:9px;height:7px;background:#ff6577;clip-path:polygon(0 0,100% 0,50% 100%)}.empty-message{position:absolute;inset:0;display:grid;place-items:center;color:#48566c;font-size:8px;pointer-events:none}
</style>
