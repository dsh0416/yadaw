<script setup lang="ts">
import { computed } from "vue"
import type { TempoMapSnapshot } from "@yadaw/contracts"
import { barTicksThroughTick } from "../../utils/tempoMap"
import { timelineXToSeconds } from "../../utils/timelineCoordinates"

const props = defineProps<{
  contentWidth: number
  pixelsPerQuarter: number
  tempoMap: TempoMapSnapshot
}>()
const emit = defineEmits<{ seek: [seconds: number] }>()
const rulerStyle = computed(() => ({ width: `${props.contentWidth}px` }))
const marks = computed(() =>
  barTicksThroughTick(
    props.tempoMap,
    (props.contentWidth / props.pixelsPerQuarter) * props.tempoMap.ticksPerQuarter
  ).map((tick, index) => ({
    bar: index + 1,
    left: (tick / props.tempoMap.ticksPerQuarter) * props.pixelsPerQuarter
  }))
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
</script>

<template>
  <div class="ruler" :style="rulerStyle" aria-label="Timeline ruler" @pointerdown="seekFromPointer">
    <span
      v-for="mark in marks"
      :key="mark.bar"
      class="bar-mark"
      :style="{ left: `${mark.left}px` }"
    >
      {{ String(mark.bar).padStart(2, "0") }}
    </span>
  </div>
</template>

<style scoped>
.ruler {
  position: relative;
  height: 43px;
  overflow: hidden;
  border-bottom: 1px solid var(--line-strong);
  background: var(--daw-ruler);
  cursor: text;
  user-select: none;
}
.ruler::after {
  position: absolute;
  top: 16px;
  right: 0;
  left: 0;
  height: 1px;
  background: var(--line-soft);
  content: "";
}
.bar-mark {
  position: absolute;
  top: 16px;
  bottom: 0;
  min-width: 28px;
  padding: 8px 0 0 7px;
  border-left: 1px solid var(--daw-grid-line);
  color: var(--text-muted);
  font: 8px var(--font-utility);
  pointer-events: none;
}
.bar-mark::after {
  position: absolute;
  top: 15px;
  left: 25%;
  width: 1px;
  height: 4px;
  background: var(--daw-grid-line);
  box-shadow:
    7px 0 var(--daw-grid-line),
    14px 0 var(--daw-grid-line);
  content: "";
}
</style>
