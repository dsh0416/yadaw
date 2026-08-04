<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import {
  DEFAULT_PROJECT_END_TICK,
  type TempoMapSnapshot,
  type TransportLoopRange
} from "@heron/contracts"
import {
  barLengthTicksAtTick,
  barTicksThroughTick,
  beatTicksThroughTick
} from "../../utils/tempoMap"
import { timelineXToSeconds } from "../../utils/timelineCoordinates"
import { tickToTimelineX } from "../../utils/timelineCoordinates"
import { useCycleRangeDrag } from "./useCycleRangeDrag"
import { useProjectEndDrag } from "./useProjectEndDrag"

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    contentWidth: number
    pixelsPerQuarter: number
    tempoMap: TempoMapSnapshot
    loopEnabled?: boolean
    loopRange?: TransportLoopRange | null
    cycleDisabled?: boolean
    projectEndTick?: number
  }>(),
  {
    loopEnabled: false,
    loopRange: null,
    cycleDisabled: false,
    projectEndTick: DEFAULT_PROJECT_END_TICK
  }
)
const emit = defineEmits<{
  seek: [seconds: number]
  updateLoopRange: [range: TransportLoopRange]
  updateProjectEnd: [endTick: number]
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
const projectEndDrag = useProjectEndDrag({
  endTick: () => props.projectEndTick,
  tempoMap: () => props.tempoMap,
  pixelsPerQuarter: () => props.pixelsPerQuarter,
  commit: (endTick) => emit("updateProjectEnd", endTick)
})
const displayedProjectEndTick = computed(() => projectEndDrag.preview.value ?? props.projectEndTick)
const projectEndLeft = computed(() =>
  tickToTimelineX(props.tempoMap, displayedProjectEndTick.value, props.pixelsPerQuarter)
)
const projectEndMarkerStyle = computed(() => ({ left: `${projectEndLeft.value}px` }))
const projectEndShadeStyle = computed(() => ({
  left: `${projectEndLeft.value}px`,
  width: `${Math.max(0, props.contentWidth - projectEndLeft.value)}px`
}))
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

function beginProjectEndGesture(event: PointerEvent): void {
  event.stopPropagation()
  event.preventDefault()
  projectEndDrag.start(event)
}

function continueProjectEndGesture(event: PointerEvent): void {
  event.stopPropagation()
  event.preventDefault()
  projectEndDrag.update(event)
}

function finishProjectEndGesture(event: PointerEvent): void {
  event.stopPropagation()
  event.preventDefault()
  projectEndDrag.finish(event)
}

function moveProjectEndFromKeyboard(direction: -1 | 1): void {
  const boundaries = barTicksThroughTick(
    props.tempoMap,
    props.projectEndTick + barLengthTicksAtTick(props.tempoMap, props.projectEndTick) * 2
  ).filter((tick) => tick > 0)
  const currentIndex = boundaries.findIndex((tick) => tick >= props.projectEndTick)
  const targetIndex = Math.max(0, currentIndex + direction)
  const endTick = boundaries[targetIndex]
  if (endTick !== undefined && endTick !== props.projectEndTick) emit("updateProjectEnd", endTick)
}

function handleProjectEndKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
  event.preventDefault()
  moveProjectEndFromKeyboard(event.key === "ArrowLeft" ? -1 : 1)
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
    <span
      class="project-end-shade"
      :style="projectEndShadeStyle"
      data-testid="project-end-shade"
      aria-hidden="true"
    />
    <button
      type="button"
      class="project-end-marker"
      :class="{ dragging: projectEndDrag.active.value }"
      :style="projectEndMarkerStyle"
      :aria-label="t('studio.arrangement.projectEndAria')"
      :title="t('studio.arrangement.projectEndTooltip')"
      data-testid="project-end-marker"
      @keydown="handleProjectEndKeydown"
      @pointerdown="beginProjectEndGesture"
      @pointermove="continueProjectEndGesture"
      @pointerup="finishProjectEndGesture"
      @pointercancel="projectEndDrag.cancel"
    />
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
  border: 1px solid var(--loop);
  border-radius: 3px;
  background: var(--loop);
  cursor: grab;
  opacity: 0.44;
}
.cycle-range.enabled {
  box-shadow: 0 0 8px color-mix(in srgb, var(--loop) 42%, transparent);
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
.project-end-shade {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  top: 16px;
  bottom: 0;
  background: color-mix(in srgb, var(--ui-domain-color-000) 38%, transparent);
  pointer-events: none;
}
.project-end-marker {
  position: absolute;
  z-index: calc(var(--ui-z-local-raised) + 1);
  top: 0;
  width: 13px;
  height: 18px;
  padding: 0;
  border: 0;
  color: var(--text-secondary);
  background: currentColor;
  clip-path: polygon(0 0, 100% 0, 100% 54%, 50% 100%, 0 54%);
  cursor: ew-resize;
  transform: translateX(-6px);
  touch-action: none;
}
.project-end-marker:hover,
.project-end-marker.dragging {
  color: var(--text-primary);
}
.project-end-marker:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
</style>
