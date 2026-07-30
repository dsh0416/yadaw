<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { TempoMapSnapshot } from "@yadaw/contracts"
import { barTicksThroughTick, beatTicksThroughTick } from "../../utils/tempoMap"
import { timelineXToSeconds } from "../../utils/timelineCoordinates"

const { t } = useI18n()

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
const beatMarks = computed(() =>
  beatTicksThroughTick(
    props.tempoMap,
    (props.contentWidth / props.pixelsPerQuarter) * props.tempoMap.ticksPerQuarter
  ).map((tick) => ({
    tick,
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
  <div
    class="ruler"
    :style="rulerStyle"
    :aria-label="t('studio.arrangement.timelineRulerAria')"
    @pointerdown="seekFromPointer"
  >
    <span
      v-for="mark in beatMarks"
      :key="mark.tick"
      class="beat-mark"
      :style="{ left: `${mark.left}px` }"
      aria-hidden="true"
    />
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
  font: var(--ui-type-size-control) var(--ui-type-family-data);
  pointer-events: none;
}
.beat-mark {
  position: absolute;
  top: 16px;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--daw-grid-line) 32%, transparent);
  pointer-events: none;
}
</style>
