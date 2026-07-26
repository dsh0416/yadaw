<script setup lang="ts">
import { computed, watch } from "vue"
import type { TempoMapSnapshot, WaveformDisplayMode } from "@yadaw/contracts"
import type { TimelineClip } from "../../stores/transport"
import { useClipWaveform } from "../../composables/useClipWaveform"
import { secondsToTimelineX } from "../../utils/timelineCoordinates"
import { secondsToTick, tempoAtTick } from "../../utils/tempoMap"
import ChannelFormatIcon from "./ChannelFormatIcon.vue"
import WaveformCanvas from "./WaveformCanvas.vue"

const props = defineProps<{
  clip: TimelineClip
  tempoMap: TempoMapSnapshot
  pixelsPerQuarter: number
  viewportStartSeconds: number
  viewportEndSeconds: number
  amplitudeScale: number
  displayMode: WaveformDisplayMode
  selected: boolean
  trackColor: string
  recording?: boolean
  dragging?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  waveformFrameCount: [frameCount: number, sampleRate: number]
  dragStart: [clipId: string, offsetPixels: number]
  dragEnd: []
}>()

const clipStartX = computed(() =>
  secondsToTimelineX(props.tempoMap, props.clip.startSeconds, props.pixelsPerQuarter)
)
const clipEndX = computed(() =>
  secondsToTimelineX(props.tempoMap, props.clip.endSeconds, props.pixelsPerQuarter)
)
const clipStyle = computed(() => ({
  left: `${clipStartX.value}px`,
  width: `${Math.max(12, clipEndX.value - clipStartX.value)}px`,
  "--clip-color": props.trackColor
}))
const visibleStartSeconds = computed(() =>
  Math.max(props.clip.startSeconds, props.viewportStartSeconds)
)
const visibleEndSeconds = computed(() => Math.min(props.clip.endSeconds, props.viewportEndSeconds))
const visibleWidth = computed(() =>
  Math.max(
    1,
    secondsToTimelineX(props.tempoMap, visibleEndSeconds.value, props.pixelsPerQuarter) -
      secondsToTimelineX(props.tempoMap, visibleStartSeconds.value, props.pixelsPerQuarter)
  )
)
const waveformTimelineStartX = computed(() =>
  secondsToTimelineX(props.tempoMap, visibleStartSeconds.value, props.pixelsPerQuarter)
)
const waveformSourceResolution = computed(() => {
  const startTick = secondsToTick(props.tempoMap, visibleStartSeconds.value)
  const endTick = secondsToTick(props.tempoMap, visibleEndSeconds.value)
  const maximumTempo = Math.max(
    tempoAtTick(props.tempoMap, startTick),
    ...props.tempoMap.tempoEvents
      .filter((event) => event.tick > startTick && event.tick < endTick)
      .map((event) => event.beatsPerMinute)
  )
  return Math.max(
    visibleWidth.value,
    ((Math.max(0, visibleEndSeconds.value - visibleStartSeconds.value) * maximumTempo) / 60) *
      props.pixelsPerQuarter
  )
})
const waveformStyle = computed(() => ({
  left: `${
    secondsToTimelineX(props.tempoMap, visibleStartSeconds.value, props.pixelsPerQuarter) -
    clipStartX.value
  }px`,
  width: `${visibleWidth.value}px`
}))
const startFrame = computed(() =>
  Math.max(
    0,
    Math.floor((visibleStartSeconds.value - props.clip.startSeconds) * props.clip.sampleRate)
  )
)
const endFrame = computed(() =>
  props.recording
    ? Number.MAX_SAFE_INTEGER
    : Math.max(
        startFrame.value,
        Math.ceil((visibleEndSeconds.value - props.clip.startSeconds) * props.clip.sampleRate)
      )
)
const { data: waveformData, loading: waveformLoading } = useClipWaveform({
  id: () => props.clip.assetId,
  recording: () => Boolean(props.recording),
  startFrame,
  endFrame,
  pixelWidth: waveformSourceResolution
})

watch(
  () => waveformData.value?.frameCount,
  (frameCount) => {
    if (props.recording && frameCount !== undefined && waveformData.value) {
      emit("waveformFrameCount", frameCount, waveformData.value.sampleRate)
    }
  }
)

function startDrag(event: DragEvent): void {
  if (props.recording || !event.dataTransfer) {
    event.preventDefault()
    return
  }
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  event.dataTransfer.effectAllowed = "move"
  const dragImage = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
    ".transparent-drag-image"
  )
  if (dragImage && typeof event.dataTransfer.setDragImage === "function") {
    event.dataTransfer.setDragImage(dragImage, 0, 0)
  }
  const offsetPixels = Math.max(0, event.clientX - bounds.left)
  event.dataTransfer.setData(
    "application/x-yadaw-clip",
    JSON.stringify({
      id: props.clip.id,
      offsetPixels
    })
  )
  emit("dragStart", props.clip.id, offsetPixels)
}
</script>

<template>
  <button
    :class="['audio-clip', { selected, recording, dragging }]"
    :style="clipStyle"
    :aria-label="`${recording ? 'Recording' : 'Audio clip'} ${clip.name}`"
    :aria-pressed="selected"
    :draggable="!recording"
    @pointerdown.stop
    @click.stop="emit('select', clip.id)"
    @dragstart.stop="startDrag"
    @dragend="emit('dragEnd')"
  >
    <span class="transparent-drag-image" aria-hidden="true" />
    <span class="clip-heading" :title="clip.name">
      <b class="clip-name">{{ clip.name }}</b>
      <span v-if="recording" class="capture-dot" aria-label="Recording" />
      <ChannelFormatIcon :channels="clip.channels" />
    </span>
    <span v-if="visibleEndSeconds > visibleStartSeconds" class="waveform" :style="waveformStyle">
      <WaveformCanvas
        :window="waveformData"
        :display-mode="displayMode"
        :amplitude-scale="amplitudeScale"
        :loading="waveformLoading"
        :recording="recording"
        :tempo-map="tempoMap"
        :pixels-per-quarter="pixelsPerQuarter"
        :timeline-start-x="waveformTimelineStartX"
        :clip-start-seconds="clip.startSeconds"
      />
    </span>
  </button>
</template>

<style scoped>
.audio-clip {
  --clip-color: var(--accent);
  position: absolute;
  z-index: 2;
  top: 9px;
  bottom: 9px;
  display: block;
  min-width: 12px;
  overflow: hidden;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--clip-color) 72%, white);
  border-radius: 4px;
  color: #f7f8f8;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--clip-color) 65%, #303436),
    color-mix(in srgb, var(--clip-color) 38%, #17191a)
  );
  box-shadow:
    0 1px 0 #ffffff24 inset,
    0 7px 18px var(--shadow);
  cursor: grab;
  text-align: left;
}
.audio-clip:hover {
  border-color: color-mix(in srgb, var(--clip-color) 55%, white);
  filter: brightness(1.08);
}
.audio-clip:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -3px;
}
.audio-clip.selected {
  z-index: 3;
  border-color: #fff;
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--clip-color) 60%, transparent) inset,
    0 0 20px color-mix(in srgb, var(--clip-color) 45%, transparent);
}
.audio-clip.dragging {
  opacity: 0.2;
  cursor: grabbing;
}
.audio-clip.recording {
  border-color: color-mix(in srgb, var(--record) 72%, white);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--record) 72%, #303436),
    color-mix(in srgb, var(--record) 42%, #17191a)
  );
  box-shadow: 0 0 18px color-mix(in srgb, var(--record) 35%, transparent);
}
.transparent-drag-image {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.clip-heading {
  position: absolute;
  z-index: 3;
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 23px;
  padding: 4px 6px 5px;
  color: #f7f8f8;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--clip-color) 34%, #111111e8) 0%,
    color-mix(in srgb, var(--clip-color) 24%, #111111b8) 72%,
    transparent 100%
  );
  pointer-events: none;
  white-space: nowrap;
}
.recording .clip-heading {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--record) 34%, #111111e8) 0%,
    color-mix(in srgb, var(--record) 24%, #111111b8) 72%,
    transparent 100%
  );
}
.clip-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: 9px;
  font-weight: 650;
  line-height: 13px;
  text-overflow: ellipsis;
  text-shadow: 0 1px 2px #000a;
}
.channel-format {
  color: #f0f4f5;
  filter: drop-shadow(0 1px 1px #0008);
}
.recording .channel-format {
  color: #ffe0e4;
}
.capture-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border: 1px solid #ffe5e9;
  border-radius: 50%;
  background: var(--record);
  box-shadow: 0 0 5px var(--record);
}
.waveform {
  position: absolute;
  z-index: 1;
  top: 22px;
  right: 0;
  bottom: 3px;
  overflow: hidden;
  opacity: 0.94;
}
</style>
