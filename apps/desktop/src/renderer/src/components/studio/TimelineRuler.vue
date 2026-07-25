<script setup lang="ts">
import { computed } from "vue"
import type { TempoMapSnapshot } from "@yadaw/contracts"
import { tickToSeconds } from "../../utils/tempoMap"

const props = defineProps<{
  contentWidth: number
  pixelsPerSecond: number
  tempo: number
  beatsPerBar: number
  tempoMap: TempoMapSnapshot
}>()
const emit = defineEmits<{ seek: [seconds: number] }>()
const rulerStyle = computed(() => ({ width: `${props.contentWidth}px` }))
const marks = computed(() => {
  const barDuration = 60 / props.tempo * props.beatsPerBar
  const count = Math.min(2_048, Math.ceil(props.contentWidth / props.pixelsPerSecond / barDuration))
  return Array.from({ length: count }, (_, index) => ({
    bar: index + 1,
    left: index * barDuration * props.pixelsPerSecond
  }))
})
const tempoMarkers = computed(() => props.tempoMap.tempoEvents.map((event) => ({
  ...event,
  left: tickToSeconds(props.tempoMap, event.tick) * props.pixelsPerSecond
})))

function seekFromPointer(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  emit("seek", Math.max(0, (event.clientX - bounds.left) / props.pixelsPerSecond))
}
</script>

<template>
  <div class="ruler" :style="rulerStyle" aria-label="Timeline ruler" @pointerdown="seekFromPointer">
    <span
      v-for="marker in tempoMarkers"
      :key="marker.tick"
      class="tempo-marker"
      :style="{ left: `${marker.left}px` }"
    >{{ marker.beatsPerMinute.toFixed(2) }}</span>
    <span v-for="mark in marks" :key="mark.bar" class="bar-mark" :style="{ left: `${mark.left}px` }">
      {{ String(mark.bar).padStart(2, "0") }}
    </span>
  </div>
</template>

<style scoped>
.ruler{position:relative;height:43px;overflow:hidden;border-bottom:1px solid var(--line-strong);background:var(--daw-ruler);cursor:text;user-select:none}.ruler::after{position:absolute;top:16px;right:0;left:0;height:1px;background:var(--line-soft);content:""}.tempo-marker{position:absolute;z-index:2;top:2px;height:12px;padding:1px 4px;border-left:2px solid #73D6A2;color:#73D6A2;background:color-mix(in srgb,#73D6A2 8%,var(--daw-ruler));font:6px var(--font-utility);pointer-events:none}.bar-mark{position:absolute;top:16px;bottom:0;min-width:28px;padding:8px 0 0 7px;border-left:1px solid var(--daw-grid-line);color:var(--text-muted);font:8px var(--font-utility);pointer-events:none}.bar-mark::after{position:absolute;top:15px;left:25%;width:1px;height:4px;background:var(--daw-grid-line);box-shadow:7px 0 var(--daw-grid-line),14px 0 var(--daw-grid-line);content:""}
</style>
