<script setup lang="ts">
import { computed } from "vue"
import type { TempoMapSnapshot, WaveformDisplayMode } from "@yadaw/contracts"
import type { TimelineClip } from "../../stores/transport"
import { barTicksThroughTick } from "../../utils/tempoMap"
import {
  secondsToTimelineX,
  timelineXToSeconds,
  timelineXToTick
} from "../../utils/timelineCoordinates"
import AudioClipCard from "./AudioClipCard.vue"

const props = defineProps<{
  clips: TimelineClip[]
  contentWidth: number
  tempoMap: TempoMapSnapshot
  pixelsPerQuarter: number
  trackHeight: number
  amplitudeScale: number
  displayMode: WaveformDisplayMode
  viewportStartSeconds: number
  viewportEndSeconds: number
  selectedClipId: string | null
  liveClip: TimelineClip | null
  trackId: string
  trackColor: string
  dragPreview: TimelineClip | null
  draggingClipId: string | null
}>()

const emit = defineEmits<{
  seek: [seconds: number]
  selectClip: [id: string]
  waveformFrameCount: [frameCount: number, sampleRate: number]
  clipDragStart: [clipId: string, offsetPixels: number]
  clipDragEnd: []
}>()

const laneStyle = computed(() => ({
  width: `${props.contentWidth}px`,
  height: `${props.trackHeight}px`
}))
const barLines = computed(() => {
  const maximumTick = timelineXToTick(props.tempoMap, props.contentWidth, props.pixelsPerQuarter)
  return barTicksThroughTick(props.tempoMap, maximumTick).map(
    (tick) => (tick / props.tempoMap.ticksPerQuarter) * props.pixelsPerQuarter
  )
})
const displayedClips = computed(() =>
  props.liveClip
    ? [...props.clips.filter((clip) => clip.id !== props.liveClip?.id), props.liveClip]
    : props.clips
)
const dragPreviewStyle = computed(() =>
  props.dragPreview
    ? {
        left: `${secondsToTimelineX(
          props.tempoMap,
          props.dragPreview.startSeconds,
          props.pixelsPerQuarter
        )}px`,
        width: `max(${
          secondsToTimelineX(props.tempoMap, props.dragPreview.endSeconds, props.pixelsPerQuarter) -
          secondsToTimelineX(props.tempoMap, props.dragPreview.startSeconds, props.pixelsPerQuarter)
        }px, 12px)`,
        "--clip-color": props.trackColor
      }
    : {}
)

function seekFromPointer(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  emit(
    "seek",
    timelineXToSeconds(
      props.tempoMap,
      Math.max(0, event.clientX - bounds.left),
      props.pixelsPerQuarter
    )
  )
}
function relayWaveformFrameCount(frameCount: number, sampleRate: number): void {
  emit("waveformFrameCount", frameCount, sampleRate)
}
function relayClipDragStart(clipId: string, offsetPixels: number): void {
  emit("clipDragStart", clipId, offsetPixels)
}
</script>

<template>
  <div
    :class="['track-lane', { 'drag-target': dragPreview }]"
    :data-track-id="trackId"
    data-track-kind="audio"
    :style="laneStyle"
    @pointerdown="seekFromPointer"
  >
    <i
      v-for="(left, index) in barLines"
      :key="index"
      class="bar-line"
      :style="{ left: `${left}px` }"
    />
    <AudioClipCard
      v-for="clip in displayedClips"
      :key="clip.id"
      :clip="clip"
      :track-color="trackColor"
      :tempo-map="tempoMap"
      :pixels-per-quarter="pixelsPerQuarter"
      :viewport-start-seconds="viewportStartSeconds"
      :viewport-end-seconds="viewportEndSeconds"
      :amplitude-scale="amplitudeScale"
      :display-mode="displayMode"
      :selected="clip.id === selectedClipId"
      :recording="clip.id === liveClip?.id"
      :dragging="clip.id === draggingClipId"
      @select="emit('selectClip', $event)"
      @waveform-frame-count="relayWaveformFrameCount"
      @drag-start="relayClipDragStart"
      @drag-end="emit('clipDragEnd')"
    />
    <div
      v-if="dragPreview"
      class="clip-drop-preview"
      data-testid="clip-drop-preview"
      :style="dragPreviewStyle"
      aria-hidden="true"
    >
      <span>{{ dragPreview.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.track-lane {
  position: relative;
  min-width: 100%;
  overflow: hidden;
  border-bottom: 1px solid var(--line-strong);
  background-color: var(--daw-lane);
  background-image: repeating-linear-gradient(
    0deg,
    transparent 0 24px,
    var(--daw-lane-stripe) 25px
  );
  cursor: crosshair;
}
.track-lane.drag-target {
  background-color: color-mix(in srgb, var(--clip-color, var(--accent)) 8%, var(--daw-lane));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 50%, transparent) inset;
}
.bar-line {
  position: absolute;
  z-index: var(--ui-z-local-base);
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--daw-grid-line);
  pointer-events: none;
}
.clip-drop-preview {
  --clip-color: var(--accent);
  position: absolute;
  z-index: var(--ui-z-local-sticky);
  top: 9px;
  bottom: 9px;
  min-width: 12px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--clip-color) 48%, white);
  border-radius: 4px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--clip-color) 65%, var(--ui-domain-color-303436)),
    color-mix(in srgb, var(--clip-color) 38%, var(--ui-domain-color-17191a))
  );
  box-shadow:
    0 0 0 1px var(--ui-domain-color-ffffff7a) inset,
    0 0 18px color-mix(in srgb, var(--clip-color) 48%, transparent);
  opacity: 0.92;
  pointer-events: none;
}
.clip-drop-preview span {
  display: block;
  overflow: hidden;
  padding: 5px 6px;
  color: var(--ui-domain-color-fff);
  font-size: 9px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
