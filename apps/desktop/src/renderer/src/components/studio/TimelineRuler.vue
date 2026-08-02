<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { TempoMapSnapshot, TransportLoopRange } from "@yadaw/contracts"
import { barTicksThroughTick, beatTicksThroughTick } from "../../utils/tempoMap"
import { timelineXToSeconds } from "../../utils/timelineCoordinates"
import { tickToTimelineX } from "../../utils/timelineCoordinates"
import { useCycleRangeDrag } from "./useCycleRangeDrag"

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    contentWidth: number
    pixelsPerQuarter: number
    tempoMap: TempoMapSnapshot
    loopEnabled?: boolean
    loopRange?: TransportLoopRange | null
    cycleDisabled?: boolean
  }>(),
  { loopEnabled: false, loopRange: null, cycleDisabled: false }
)
const emit = defineEmits<{
  seek: [seconds: number]
  updateLoopRange: [range: TransportLoopRange]
}>()
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
const { preview, start, update, finish, cancel } = useCycleRangeDrag({
  range: () => props.loopRange,
  tempoMap: () => props.tempoMap,
  pixelsPerQuarter: () => props.pixelsPerQuarter,
  commit: (range) => emit("updateLoopRange", range)
})
const displayedRange = computed(() => preview.value ?? props.loopRange)
const cycleStyle = computed(() => {
  const range = displayedRange.value
  if (!range) return {}
  const left = tickToTimelineX(props.tempoMap, range.startTick, props.pixelsPerQuarter)
  const right = tickToTimelineX(props.tempoMap, range.endTick, props.pixelsPerQuarter)
  return { left: `${left}px`, width: `${Math.max(2, right - left)}px` }
})
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

function beginCycleGesture(event: PointerEvent, mode: Parameters<typeof start>[1]): void {
  if (props.cycleDisabled) return
  event.stopPropagation()
  event.preventDefault()
  start(event, mode)
}

function continueCycleGesture(event: PointerEvent): void {
  if (props.cycleDisabled) return
  event.stopPropagation()
  event.preventDefault()
  update(event)
}

function finishCycleGesture(event: PointerEvent): void {
  if (props.cycleDisabled) return
  event.stopPropagation()
  event.preventDefault()
  finish(event)
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
    <div
      :class="['cycle-lane', { disabled: cycleDisabled }]"
      :aria-label="t('studio.arrangement.cycleLaneAria')"
      @pointerdown.self="beginCycleGesture($event, 'create')"
      @pointermove.self="continueCycleGesture"
      @pointerup.self="finishCycleGesture"
      @pointercancel="cancel"
    >
      <span
        v-if="displayedRange"
        :class="['cycle-range', { enabled: loopEnabled }]"
        :style="cycleStyle"
        data-testid="cycle-range"
        @pointerdown="beginCycleGesture($event, 'move')"
        @pointermove="continueCycleGesture"
        @pointerup="finishCycleGesture"
        @pointercancel="cancel"
      >
        <i
          class="cycle-edge cycle-edge-start"
          data-testid="cycle-edge-start"
          @pointerdown="beginCycleGesture($event, 'resize-start')"
          @pointermove="continueCycleGesture"
          @pointerup="finishCycleGesture"
          @pointercancel="cancel"
        />
        <i
          class="cycle-edge cycle-edge-end"
          data-testid="cycle-edge-end"
          @pointerdown="beginCycleGesture($event, 'resize-end')"
          @pointermove="continueCycleGesture"
          @pointerup="finishCycleGesture"
          @pointercancel="cancel"
        />
      </span>
    </div>
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
.cycle-lane {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  top: 0;
  right: 0;
  left: 0;
  height: 16px;
  cursor: crosshair;
  touch-action: none;
}
.cycle-lane.disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.cycle-range {
  position: absolute;
  top: 2px;
  bottom: 2px;
  min-width: 2px;
  border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--line-strong));
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 26%, var(--surface-raised));
  cursor: grab;
  opacity: 0.7;
}
.cycle-range.enabled {
  background: color-mix(in srgb, var(--accent) 58%, var(--surface-raised));
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 35%, transparent);
  opacity: 1;
}
.cycle-edge {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 7px;
  cursor: ew-resize;
}
.cycle-edge-start {
  left: -3px;
}
.cycle-edge-end {
  right: -3px;
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
