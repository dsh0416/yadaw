<script setup lang="ts">
import { computed } from "vue"
import type { MidiClipState, TempoMapSnapshot } from "@yadaw/contracts"
import { barTicksThroughTick, beatTicksThroughTick } from "../../utils/tempoMap"
import { timelineXToTick } from "../../utils/timelineCoordinates"

const props = defineProps<{
  trackId: string
  trackColor: string
  clips: MidiClipState[]
  tempoMap: TempoMapSnapshot
  contentWidth: number
  pixelsPerQuarter: number
  trackHeight: number
}>()

const emit = defineEmits<{
  move: [clipId: string, trackId: string, startTick: number]
  remove: [clipId: string]
}>()

const style = computed(() => ({
  width: `${props.contentWidth}px`,
  height: `${props.trackHeight}px`
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

function clipStyle(clip: MidiClipState) {
  const pixelsPerTick = props.pixelsPerQuarter / props.tempoMap.ticksPerQuarter
  return {
    left: `${clip.startTick * pixelsPerTick}px`,
    width: `${Math.max(9, clip.lengthTicks * pixelsPerTick)}px`,
    borderColor: props.trackColor,
    background: `color-mix(in srgb, ${props.trackColor} 20%, var(--surface-sunken))`
  }
}

function noteStyle(clip: MidiClipState, note: MidiClipState["notes"][number]) {
  const left = (note.startTick / clip.lengthTicks) * 100
  const width = Math.max(0.8, (note.durationTicks / clip.lengthTicks) * 100)
  return {
    left: `${left}%`,
    width: `${width}%`,
    bottom: `${(note.key / 127) * 72 + 8}%`,
    background: props.trackColor
  }
}

function handleKeydown(event: KeyboardEvent, clip: MidiClipState): void {
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault()
    emit("remove", clip.id)
  }
}

function startDrag(event: DragEvent, clip: MidiClipState): void {
  event.dataTransfer?.setData("application/x-yadaw-midi-clip", clip.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
}

function dropClip(event: DragEvent): void {
  const clipId = event.dataTransfer?.getData("application/x-yadaw-midi-clip")
  if (!clipId) return
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const tick = timelineXToTick(
    props.tempoMap,
    Math.max(0, event.clientX - bounds.left),
    props.pixelsPerQuarter
  )
  emit("move", clipId, props.trackId, tick)
}
</script>

<template>
  <div
    class="midi-track"
    :style="style"
    :data-track-id="trackId"
    data-track-kind="instrument"
    @dragover.prevent
    @drop.prevent="dropClip"
  >
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
    <button
      v-for="clip in clips"
      :key="clip.id"
      class="midi-clip"
      draggable="true"
      :style="clipStyle(clip)"
      :aria-label="`${clip.name}, MIDI clip`"
      @dragstart="startDrag($event, clip)"
      @keydown="handleKeydown($event, clip)"
    >
      <strong>{{ clip.name }}</strong>
      <span
        v-for="note in clip.notes"
        :key="note.id"
        class="midi-note"
        :style="noteStyle(clip, note)"
      />
    </button>
  </div>
</template>

<style scoped>
.midi-track {
  position: relative;
  overflow: hidden;
  border-bottom: 1px solid var(--line-strong);
  background: var(--daw-lane);
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
.midi-clip {
  position: absolute;
  top: 5px;
  bottom: 5px;
  overflow: hidden;
  min-width: 9px;
  padding: 4px 5px;
  border: 1px solid;
  border-radius: 3px;
  color: var(--text-primary);
  text-align: left;
  cursor: grab;
}
.midi-clip:active {
  cursor: grabbing;
}
.midi-clip:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.midi-clip strong {
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
