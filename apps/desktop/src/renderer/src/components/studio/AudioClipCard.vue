<script setup lang="ts">
import { computed, watch } from "vue"
import { useI18n } from "vue-i18n"
import { UiContextMenu, type UiMenuEntry } from "@yadaw/ui"
import type { AudioClipState, TempoMapSnapshot, WaveformDisplayMode } from "@yadaw/contracts"
import type { TimelineClip } from "../../stores/transport"
import { useClipWaveform } from "../../composables/useClipWaveform"
import {
  createEqualPowerFadeCurvePath,
  createEqualPowerFadeShadePath
} from "../../utils/audioFadeCurve"
import { secondsToTimelineX } from "../../utils/timelineCoordinates"
import { secondsToTick, tempoAtTick } from "../../utils/tempoMap"
import {
  projectFrameToAssetFrame,
  type AudioFadeEdge,
  type ClipTrimEdge
} from "../../utils/clipEditing"
import ChannelFormatIcon from "./ChannelFormatIcon.vue"
import WaveformCanvas from "./WaveformCanvas.vue"
import { useAudioClipEdit } from "./useAudioClipEdit"

const { t } = useI18n()

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
  playheadFrame: number
  splitShortcut?: string
}>()

const emit = defineEmits<{
  select: [id: string]
  waveformFrameCount: [frameCount: number, sampleRate: number]
  dragStart: [clipId: string, offsetPixels: number]
  dragEnd: []
  remove: [clipId: string]
  split: [clipId: string]
  trim: [clipId: string, edge: ClipTrimEdge, frame: number]
  fade: [clipId: string, edge: AudioFadeEdge, frames: number]
  resetFades: [clipId: string]
}>()

const clipState = computed<AudioClipState>(() => ({
  id: props.clip.id,
  assetId: props.clip.assetId,
  trackId: props.clip.trackId,
  name: props.clip.name,
  startFrame: props.clip.startFrame,
  sourceOffsetFrames: props.clip.sourceOffsetFrames,
  lengthFrames: props.clip.lengthFrames,
  sourceLengthFrames: props.clip.sourceLengthFrames,
  fadeInFrames: props.clip.fadeInFrames,
  fadeOutFrames: props.clip.fadeOutFrames,
  assetSampleRate: props.clip.sampleRate,
  assetChannels: props.clip.channels
}))
const { active, preview, startTrim, startFade, update, finish, cancel } = useAudioClipEdit({
  clip: clipState,
  tempoMap: () => props.tempoMap,
  pixelsPerQuarter: () => props.pixelsPerQuarter,
  projectSampleRate: () => props.clip.projectSampleRate,
  commitTrim: (edge, frame) => emit("trim", props.clip.id, edge, frame),
  commitFade: (edge, frames) => emit("fade", props.clip.id, edge, frames)
})
const displayedClip = computed(() => preview.value ?? clipState.value)
const displayedStartSeconds = computed(
  () => displayedClip.value.startFrame / props.clip.projectSampleRate
)
const displayedEndSeconds = computed(
  () =>
    (displayedClip.value.startFrame + displayedClip.value.lengthFrames) /
    props.clip.projectSampleRate
)
const clipStartX = computed(() =>
  secondsToTimelineX(props.tempoMap, displayedStartSeconds.value, props.pixelsPerQuarter)
)
const clipEndX = computed(() =>
  secondsToTimelineX(props.tempoMap, displayedEndSeconds.value, props.pixelsPerQuarter)
)
const clipStyle = computed(() => ({
  left: `${clipStartX.value}px`,
  width: `${Math.max(12, clipEndX.value - clipStartX.value)}px`,
  "--clip-color": props.trackColor
}))
const visibleStartSeconds = computed(() =>
  Math.max(displayedStartSeconds.value, props.viewportStartSeconds)
)
const visibleEndSeconds = computed(() =>
  Math.min(displayedEndSeconds.value, props.viewportEndSeconds)
)
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
  projectFrameToAssetFrame(
    displayedClip.value.sourceOffsetFrames +
      (visibleStartSeconds.value - displayedStartSeconds.value) * props.clip.projectSampleRate,
    props.clip.projectSampleRate,
    props.clip.sampleRate
  )
)
const endFrame = computed(() =>
  props.recording
    ? Number.MAX_SAFE_INTEGER
    : Math.max(
        startFrame.value,
        projectFrameToAssetFrame(
          displayedClip.value.sourceOffsetFrames +
            (visibleEndSeconds.value - displayedStartSeconds.value) * props.clip.projectSampleRate,
          props.clip.projectSampleRate,
          props.clip.sampleRate,
          "ceil"
        )
      )
)
const { data: waveformData, loading: waveformLoading } = useClipWaveform({
  id: () => props.clip.assetId,
  recording: () => Boolean(props.recording),
  startFrame,
  endFrame,
  pixelWidth: waveformSourceResolution
})
const canEditAtPlayhead = computed(
  () =>
    props.playheadFrame > props.clip.startFrame &&
    props.playheadFrame < props.clip.startFrame + props.clip.lengthFrames
)
const menuEntries = computed<readonly UiMenuEntry[]>(() => [
  {
    kind: "item",
    id: "split",
    label: t("studio.arrangement.splitAtPlayhead"),
    shortcut: props.splitShortcut,
    disabled: !canEditAtPlayhead.value
  },
  {
    kind: "item",
    id: "trim-start",
    label: t("studio.arrangement.trimStartToPlayhead"),
    disabled: !canEditAtPlayhead.value
  },
  {
    kind: "item",
    id: "trim-end",
    label: t("studio.arrangement.trimEndToPlayhead"),
    disabled: !canEditAtPlayhead.value
  },
  {
    kind: "item",
    id: "reset-fades",
    label: t("studio.arrangement.resetFades"),
    disabled: props.clip.fadeInFrames === 0 && props.clip.fadeOutFrames === 0
  },
  { kind: "separator", id: "delete-separator" },
  { kind: "item", id: "delete", label: t("studio.arrangement.deleteClip"), tone: "danger" }
])
const fadeInStyle = computed(() => ({
  width: `${(displayedClip.value.fadeInFrames / displayedClip.value.lengthFrames) * 100}%`
}))
const fadeOutStyle = computed(() => ({
  width: `${(displayedClip.value.fadeOutFrames / displayedClip.value.lengthFrames) * 100}%`
}))
const fadeInCurvePath = createEqualPowerFadeCurvePath("in")
const fadeOutCurvePath = createEqualPowerFadeCurvePath("out")
const fadeInShadePath = createEqualPowerFadeShadePath("in")
const fadeOutShadePath = createEqualPowerFadeShadePath("out")

watch(
  () => waveformData.value?.frameCount,
  (frameCount) => {
    if (props.recording && frameCount !== undefined && waveformData.value) {
      emit("waveformFrameCount", frameCount, waveformData.value.sampleRate)
    }
  }
)

function startDrag(event: DragEvent): void {
  if (props.recording || active.value || !event.dataTransfer) {
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

function selectMenuAction(id: string): void {
  if (id === "split") emit("split", props.clip.id)
  else if (id === "trim-start") emit("trim", props.clip.id, "start", props.playheadFrame)
  else if (id === "trim-end") emit("trim", props.clip.id, "end", props.playheadFrame)
  else if (id === "reset-fades") emit("resetFades", props.clip.id)
  else if (id === "delete") emit("remove", props.clip.id)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault()
    emit("remove", props.clip.id)
  } else if (event.key === "Escape") cancel()
}
</script>

<template>
  <UiContextMenu
    :entries="menuEntries"
    :menu-label="t('studio.arrangement.audioClipMenu', { name: clip.name })"
    @open-context="!selected && emit('select', clip.id)"
    @select="selectMenuAction"
  >
    <div
      :class="['audio-clip', { selected, recording, dragging, editing: active }]"
      :style="clipStyle"
      role="button"
      tabindex="0"
      :aria-label="`${recording ? 'Recording' : 'Audio clip'} ${clip.name}`"
      :aria-pressed="selected"
      :draggable="!recording && !active"
      @pointerdown.stop
      @click.stop="emit('select', clip.id)"
      @dragstart.stop="startDrag"
      @dragend="emit('dragEnd')"
      @keydown="handleKeydown"
    >
      <span class="transparent-drag-image" aria-hidden="true" />
      <span
        class="trim-handle trim-handle-start"
        data-testid="audio-trim-start"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('studio.arrangement.trimClipStart', { name: clip.name })"
        @pointerdown.stop.prevent="startTrim($event, 'start')"
        @pointermove.stop.prevent="update"
        @pointerup.stop.prevent="finish"
        @pointercancel="cancel"
      />
      <span
        class="fade-handle fade-handle-in"
        data-testid="audio-fade-in"
        :style="fadeInStyle"
        :aria-label="t('studio.arrangement.fadeIn', { name: clip.name })"
        role="slider"
        :aria-valuenow="displayedClip.fadeInFrames"
        @pointerdown.stop.prevent="startFade($event, 'in')"
        @pointermove.stop.prevent="update"
        @pointerup.stop.prevent="finish"
        @pointercancel="cancel"
      />
      <span
        class="fade-handle fade-handle-out"
        data-testid="audio-fade-out"
        :style="fadeOutStyle"
        :aria-label="t('studio.arrangement.fadeOut', { name: clip.name })"
        role="slider"
        :aria-valuenow="displayedClip.fadeOutFrames"
        @pointerdown.stop.prevent="startFade($event, 'out')"
        @pointermove.stop.prevent="update"
        @pointerup.stop.prevent="finish"
        @pointercancel="cancel"
      />
      <svg
        class="fade-region fade-region-in"
        :style="fadeInStyle"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path class="fade-shade" :d="fadeInShadePath" />
        <path class="fade-curve" :d="fadeInCurvePath" />
      </svg>
      <svg
        class="fade-region fade-region-out"
        :style="fadeOutStyle"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path class="fade-shade" :d="fadeOutShadePath" />
        <path class="fade-curve" :d="fadeOutCurvePath" />
      </svg>
      <span class="clip-heading" :title="clip.name">
        <b class="clip-name">{{ clip.name }}</b>
        <span
          v-if="recording"
          class="capture-dot"
          :aria-label="t('studio.arrangement.recordingAria')"
        />
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
          :clip-start-seconds="displayedStartSeconds"
        />
      </span>
      <span
        class="trim-handle trim-handle-end"
        data-testid="audio-trim-end"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('studio.arrangement.trimClipEnd', { name: clip.name })"
        @pointerdown.stop.prevent="startTrim($event, 'end')"
        @pointermove.stop.prevent="update"
        @pointerup.stop.prevent="finish"
        @pointercancel="cancel"
      />
    </div>
  </UiContextMenu>
</template>

<style scoped>
.audio-clip {
  --clip-color: var(--accent);
  position: absolute;
  z-index: var(--ui-z-local-raised);
  top: 9px;
  bottom: 9px;
  display: block;
  min-width: 12px;
  overflow: hidden;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--clip-color) 72%, white);
  border-radius: 4px;
  color: var(--ui-domain-color-f7f8f8);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--clip-color) 65%, var(--ui-domain-color-303436)),
    color-mix(in srgb, var(--clip-color) 38%, var(--ui-domain-color-17191a))
  );
  box-shadow:
    0 1px 0 var(--ui-domain-color-ffffff24) inset,
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
  z-index: var(--ui-z-local-selection);
  border-color: var(--ui-domain-color-fff);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--clip-color) 60%, transparent) inset,
    0 0 20px color-mix(in srgb, var(--clip-color) 45%, transparent);
}
.audio-clip.dragging {
  opacity: 0.2;
  cursor: grabbing;
}
.audio-clip.editing {
  z-index: var(--ui-z-local-selection);
  cursor: ew-resize;
}
.audio-clip.recording {
  border-color: color-mix(in srgb, var(--record) 72%, white);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--record) 72%, var(--ui-domain-color-303436)),
    color-mix(in srgb, var(--record) 42%, var(--ui-domain-color-17191a))
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
  z-index: var(--ui-z-local-selection);
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 23px;
  padding: 4px 6px 5px;
  color: var(--ui-domain-color-f7f8f8);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--clip-color) 34%, var(--ui-domain-color-111111e8)) 0%,
    color-mix(in srgb, var(--clip-color) 24%, var(--ui-domain-color-111111b8)) 72%,
    transparent 100%
  );
  pointer-events: none;
  white-space: nowrap;
}
.recording .clip-heading {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--record) 34%, var(--ui-domain-color-111111e8)) 0%,
    color-mix(in srgb, var(--record) 24%, var(--ui-domain-color-111111b8)) 72%,
    transparent 100%
  );
}
.clip-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: var(--ui-type-size-body-compact);
  font-weight: var(--ui-type-weight-semibold);
  line-height: var(--ui-type-leading-normal);
  text-overflow: ellipsis;
  text-shadow: 0 1px 2px var(--ui-domain-color-000a);
}
.channel-format {
  color: var(--ui-domain-color-f0f4f5);
  filter: drop-shadow(0 1px 1px var(--ui-domain-color-0008));
}
.recording .channel-format {
  color: var(--ui-domain-color-ffe0e4);
}
.capture-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border: 1px solid var(--ui-domain-color-ffe5e9);
  border-radius: 50%;
  background: var(--record);
  box-shadow: 0 0 5px var(--record);
}
.waveform {
  position: absolute;
  z-index: var(--ui-z-local-content);
  top: 22px;
  right: 0;
  bottom: 3px;
  overflow: hidden;
  opacity: 0.94;
}
.trim-handle {
  position: absolute;
  z-index: calc(var(--ui-z-local-selection) + 2);
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: ew-resize;
  touch-action: none;
}
.trim-handle-start {
  left: 0;
}
.trim-handle-end {
  right: 0;
}
.fade-handle {
  position: absolute;
  z-index: calc(var(--ui-z-local-selection) + 3);
  top: 0;
  min-width: 8px;
  max-width: 100%;
  height: 10px;
  cursor: ew-resize;
  touch-action: none;
}
.fade-handle::after {
  position: absolute;
  top: 2px;
  width: 6px;
  height: 6px;
  border: 1px solid var(--ui-domain-color-fff);
  border-radius: 50%;
  background: var(--clip-color);
  content: "";
}
.fade-handle-in {
  left: 0;
}
.fade-handle-in::after {
  right: -3px;
}
.fade-handle-out {
  right: 0;
}
.fade-handle-out::after {
  left: -3px;
}
.fade-region {
  position: absolute;
  z-index: calc(var(--ui-z-local-selection) + 1);
  top: 0;
  bottom: 0;
  height: 100%;
  pointer-events: none;
}
.fade-region-in {
  left: 0;
}
.fade-region-out {
  right: 0;
}
.fade-shade {
  fill: var(--ui-domain-color-0008);
}
.fade-curve {
  fill: none;
  stroke: var(--ui-domain-color-fff);
  stroke-width: 1.25px;
  vector-effect: non-scaling-stroke;
}
</style>
