<script setup lang="ts">
import { computed } from "vue"
import type { MidiClipState, TempoMapSnapshot } from "@yadaw/contracts"
import { tickToSeconds } from "../../utils/tempoMap"

const props = defineProps<{
  trackId: string
  trackColor: string
  clips: MidiClipState[]
  tempoMap: TempoMapSnapshot
  contentWidth: number
  pixelsPerSecond: number
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

function clipStyle(clip: MidiClipState) {
  const start = tickToSeconds(props.tempoMap, clip.startTick)
  const end = tickToSeconds(props.tempoMap, clip.startTick + clip.lengthTicks)
  return {
    left: `${start * props.pixelsPerSecond}px`,
    width: `${Math.max(9, (end - start) * props.pixelsPerSecond)}px`,
    borderColor: props.trackColor,
    background: `color-mix(in srgb, ${props.trackColor} 20%, var(--surface-sunken))`
  }
}

function noteStyle(clip: MidiClipState, note: MidiClipState["notes"][number]) {
  const left = note.startTick / clip.lengthTicks * 100
  const width = Math.max(0.8, note.durationTicks / clip.lengthTicks * 100)
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
</script>

<template>
  <div
    class="midi-track"
    :style="style"
    :data-track-id="trackId"
    data-track-kind="instrument"
  >
    <button
      v-for="clip in clips"
      :key="clip.id"
      class="midi-clip"
      :style="clipStyle(clip)"
      :aria-label="`${clip.name}, MIDI clip`"
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
.midi-track{position:relative;overflow:hidden;border-bottom:1px solid var(--line-strong);background:var(--daw-lane);background-image:linear-gradient(90deg,color-mix(in srgb,var(--text-primary) 3%,transparent) 1px,transparent 1px);background-size:48px 100%}.midi-clip{position:absolute;top:5px;bottom:5px;overflow:hidden;min-width:9px;padding:4px 5px;border:1px solid;border-radius:3px;color:var(--text-primary);text-align:left;cursor:grab}.midi-clip:focus-visible{outline:2px solid var(--focus);outline-offset:1px}.midi-clip strong{position:relative;z-index:2;display:block;overflow:hidden;font:700 7px var(--font-utility);text-overflow:ellipsis;white-space:nowrap}.midi-note{position:absolute;height:2px;min-width:1px;border-radius:1px;opacity:.9;pointer-events:none}
</style>
