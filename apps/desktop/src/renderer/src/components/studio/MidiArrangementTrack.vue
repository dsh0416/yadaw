<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { MidiClipState, MidiRecordingPreviewTake, TempoMapSnapshot } from "@yadaw/contracts"
import type { PianoRollSnap } from "../../utils/pianoRoll"
import type { ClipTrimEdge } from "../../utils/clipEditing"
import { barTicksThroughTick, beatTicksThroughTick } from "../../utils/tempoMap"
import { timelineXToTick } from "../../utils/timelineCoordinates"
import MidiClipCard from "./MidiClipCard.vue"
import MidiRecordingPreview from "./MidiRecordingPreview.vue"

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    trackId: string
    trackColor: string
    clips: MidiClipState[]
    tempoMap: TempoMapSnapshot
    contentWidth: number
    pixelsPerQuarter: number
    trackHeight: number
    selectedClipIds: string[]
    keyboardInsertionTick: number
    playheadTick?: number
    snap?: PianoRollSnap
    dragPreview: MidiClipState | null
    draggingClipId: string | null
    recording?: boolean
    recordingStartTick?: number
    recordingPositionTick?: number
    liveTake?: MidiRecordingPreviewTake | null
  }>(),
  {
    playheadTick: 0,
    snap: "1/16",
    recording: false,
    recordingStartTick: 0,
    recordingPositionTick: 0,
    liveTake: null
  }
)

const emit = defineEmits<{
  remove: [clipId: string]
  select: [clipId: string, additive: boolean]
  open: [clipId: string, selectedClipIds: string[]]
  create: [trackId: string, startTick: number]
  split: [clipId: string]
  trim: [clipId: string, edge: ClipTrimEdge, tick: number]
  clipDragStart: [clipId: string, offsetPixels: number]
  clipDragEnd: []
}>()

const style = computed(() => ({
  width: `${props.contentWidth}px`,
  height: `${props.trackHeight}px`,
  "--clip-color": props.trackColor
}))
const maximumTick = computed(() =>
  timelineXToTick(props.tempoMap, props.contentWidth, props.pixelsPerQuarter)
)
const barLines = computed(() =>
  barTicksThroughTick(props.tempoMap, maximumTick.value).map(
    (tick) => (tick / props.tempoMap.ticksPerQuarter) * props.pixelsPerQuarter
  )
)
const beatLines = computed(() =>
  beatTicksThroughTick(props.tempoMap, maximumTick.value).map(
    (tick) => (tick / props.tempoMap.ticksPerQuarter) * props.pixelsPerQuarter
  )
)
const dragPreviewStyle = computed(() => {
  if (!props.dragPreview) return {}
  const pixelsPerTick = props.pixelsPerQuarter / props.tempoMap.ticksPerQuarter
  return {
    left: `${props.dragPreview.startTick * pixelsPerTick}px`,
    width: `${Math.max(9, props.dragPreview.lengthTicks * pixelsPerTick)}px`,
    borderColor: props.trackColor,
    "--clip-color": props.trackColor
  }
})

function noteStyle(clip: MidiClipState, note: MidiClipState["notes"][number]) {
  const left = ((note.startTick - clip.sourceOffsetTicks) / clip.lengthTicks) * 100
  const width = Math.max(0.8, (note.durationTicks / clip.lengthTicks) * 100)
  return {
    left: `${left}%`,
    width: `${width}%`,
    bottom: `${(note.key / 127) * 72 + 8}%`,
    background: props.trackColor
  }
}

function createClipAtPointer(event: MouseEvent): void {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const tick = timelineXToTick(
    props.tempoMap,
    Math.max(0, event.clientX - bounds.left),
    props.pixelsPerQuarter
  )
  emit("create", props.trackId, tick)
}

function relaySelect(clipId: string, additive: boolean): void {
  emit("select", clipId, additive)
}

function relayOpen(clipId: string, selectedClipIds: string[]): void {
  emit("open", clipId, selectedClipIds)
}

function relayTrim(clipId: string, edge: ClipTrimEdge, tick: number): void {
  emit("trim", clipId, edge, tick)
}

function relayDragStart(clipId: string, offsetPixels: number): void {
  emit("clipDragStart", clipId, offsetPixels)
}
</script>

<template>
  <div
    :class="['midi-track', { 'drag-target': dragPreview }]"
    :style="style"
    :data-track-id="trackId"
    data-track-kind="instrument"
    tabindex="0"
    :aria-label="t('studio.arrangement.instrumentLaneAria')"
    @dblclick.self="createClipAtPointer"
    @keydown.enter.self="emit('create', trackId, keyboardInsertionTick)"
  >
    <span v-if="clips.length === 0 && !dragPreview && !recording" class="empty-hint">
      {{ t("studio.arrangement.createMidiClipHint") }}
    </span>
    <i
      v-for="(left, index) in beatLines"
      :key="`beat-${index}`"
      class="beat-line"
      :style="{ left: `${left}px` }"
    />
    <i
      v-for="(left, index) in barLines"
      :key="`bar-${index}`"
      class="bar-line"
      :style="{ left: `${left}px` }"
    />
    <MidiClipCard
      v-for="clip in clips"
      :key="clip.id"
      :clip="clip"
      :tempo-map="tempoMap"
      :pixels-per-quarter="pixelsPerQuarter"
      :track-color="trackColor"
      :selected-clip-ids="selectedClipIds"
      :playhead-tick="playheadTick"
      :snap="snap"
      :dragging="clip.id === draggingClipId"
      @remove="emit('remove', $event)"
      @select="relaySelect"
      @open="relayOpen"
      @split="emit('split', $event)"
      @trim="relayTrim"
      @drag-start="relayDragStart"
      @drag-end="emit('clipDragEnd')"
    />
    <MidiRecordingPreview
      v-if="recording"
      :take="liveTake"
      :start-tick="recordingStartTick"
      :position-tick="recordingPositionTick"
      :tempo-map="tempoMap"
      :pixels-per-quarter="pixelsPerQuarter"
      :track-color="trackColor"
    />
    <div
      v-if="dragPreview"
      class="midi-clip-drop-preview"
      data-testid="midi-clip-drop-preview"
      :style="dragPreviewStyle"
      aria-hidden="true"
    >
      <strong>{{ dragPreview.name }}</strong>
      <span
        v-for="note in dragPreview.notes"
        :key="note.id"
        class="midi-note"
        :style="noteStyle(dragPreview, note)"
      />
    </div>
  </div>
</template>

<style scoped>
.midi-track {
  position: relative;
  overflow: hidden;
  border-bottom: 1px solid var(--line-strong);
  background: var(--daw-lane);
}
.midi-track:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.midi-track.drag-target {
  background: color-mix(in srgb, var(--clip-color, var(--accent)) 8%, var(--daw-lane));
}
.empty-hint {
  position: absolute;
  top: 50%;
  left: var(--ui-space-3);
  color: var(--text-muted);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  pointer-events: none;
  transform: translateY(-50%);
}
.bar-line,
.beat-line {
  position: absolute;
  z-index: var(--ui-z-local-base);
  top: 0;
  bottom: 0;
  width: 1px;
  pointer-events: none;
}
.bar-line {
  background: var(--daw-grid-line);
}
.beat-line {
  background: color-mix(in srgb, var(--daw-grid-line) 32%, transparent);
}
.midi-clip-drop-preview {
  position: absolute;
  z-index: var(--ui-z-local-sticky);
  top: 5px;
  bottom: 5px;
  overflow: hidden;
  min-width: 9px;
  padding: 4px 5px;
  border: 1px solid;
  border-radius: 3px;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--clip-color) 32%, var(--surface-sunken));
  box-shadow: var(--ui-focus-ring);
  opacity: 0.92;
  pointer-events: none;
}
.midi-clip-drop-preview strong {
  position: relative;
  z-index: var(--ui-z-local-raised);
  display: block;
  overflow: hidden;
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.midi-note {
  position: absolute;
  height: 2px;
  min-width: 1px;
  border-radius: 1px;
  opacity: 0.9;
  pointer-events: none;
}
</style>
