<script setup lang="ts">
import { computed, shallowRef, useTemplateRef } from "vue"

export interface GlobalLanePoint {
  id: string
  position: number
  value: number
  lockTime?: boolean
  lockRemoval?: boolean
}

const props = defineProps<{
  points: GlobalLanePoint[]
  selectedId: string | null
  contentWidth: number
  pixelsPerUnit: number
  height: number
  minimum: number
  maximum: number
  guides: number[]
  beatGuides: number[]
  verticalGuides: number[]
  color: string
  expanded: boolean
  valueLabel: string
  positionLabel: string
}>()

const emit = defineEmits<{
  create: [position: number, value: number]
  update: [id: string, position: number, value: number]
  remove: [id: string]
  select: [id: string | null]
}>()

const lane = useTemplateRef<HTMLElement>("lane")
const drag = shallowRef<{
  id: string
  position: number
  value: number
} | null>(null)
const sortedPoints = computed(() =>
  [...props.points].sort((left, right) => left.position - right.position)
)
const renderedPoints = computed(() =>
  sortedPoints.value.map((point) =>
    drag.value?.id === point.id ? { ...point, ...drag.value } : point
  )
)
const linePath = computed(() => {
  const points = renderedPoints.value
  if (points.length === 0) return ""
  const first = points[0]!
  let path = `M 0 ${valueToY(first.value)}`
  for (const point of points.slice(1)) {
    const x = positionToX(point.position)
    path += ` H ${x} V ${valueToY(point.value)}`
  }
  return `${path} H ${props.contentWidth}`
})
const fillPath = computed(() => (linePath.value ? `${linePath.value} V ${props.height} H 0 Z` : ""))

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function positionToX(position: number): number {
  return position * props.pixelsPerUnit
}

function valueToY(value: number): number {
  const range = Math.max(1, props.maximum - props.minimum)
  return ((props.maximum - clamp(value, props.minimum, props.maximum)) / range) * props.height
}

function pointFromPointer(event: PointerEvent | MouseEvent): {
  position: number
  value: number
} {
  const bounds = lane.value?.getBoundingClientRect()
  if (!bounds) return { position: 0, value: props.minimum }
  const x = clamp(event.clientX - bounds.left, 0, props.contentWidth)
  const y = clamp(event.clientY - bounds.top, 0, props.height)
  return {
    position: x / props.pixelsPerUnit,
    value: props.maximum - (y / props.height) * (props.maximum - props.minimum)
  }
}

function createPoint(event: MouseEvent): void {
  if (!props.expanded) return
  const point = pointFromPointer(event)
  emit("create", point.position, point.value)
}

function startDrag(event: PointerEvent, point: GlobalLanePoint): void {
  if (!props.expanded) return
  event.preventDefault()
  event.stopPropagation()
  emit("select", point.id)
  drag.value = {
    id: point.id,
    position: point.position,
    value: point.value
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function updateDrag(event: PointerEvent): void {
  const current = drag.value
  if (!current) return
  const source = props.points.find((point) => point.id === current.id)
  if (!source) return
  const next = pointFromPointer(event)
  drag.value = {
    id: current.id,
    position: source.lockTime ? source.position : next.position,
    value: next.value
  }
}

function finishDrag(): void {
  const current = drag.value
  if (!current) return
  drag.value = null
  emit("update", current.id, current.position, current.value)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Delete" && event.key !== "Backspace") return
  const selected = props.points.find((point) => point.id === props.selectedId)
  if (!selected || selected.lockRemoval) return
  event.preventDefault()
  emit("remove", selected.id)
}
</script>

<template>
  <div
    ref="lane"
    class="value-lane"
    :class="{ collapsed: !expanded }"
    :style="{
      width: `${contentWidth}px`,
      height: `${height}px`,
      '--lane-color': color
    }"
    tabindex="0"
    role="application"
    :aria-label="`${valueLabel} global track editor. Double-click to add a point.`"
    @dblclick="createPoint"
    @pointermove="updateDrag"
    @pointerup="finishDrag"
    @pointercancel="finishDrag"
    @keydown="handleKeydown"
    @pointerdown.self="emit('select', null)"
  >
    <svg
      v-if="expanded"
      class="lane-graph"
      :width="contentWidth"
      :height="height"
      aria-hidden="true"
    >
      <line
        v-for="guide in beatGuides"
        :key="`beat-${guide}`"
        class="beat-guide"
        :x1="guide"
        :x2="guide"
        y1="0"
        :y2="height"
      />
      <line
        v-for="guide in verticalGuides"
        :key="`x-${guide}`"
        class="vertical-guide"
        :x1="guide"
        :x2="guide"
        y1="0"
        :y2="height"
      />
      <g v-for="guide in guides" :key="`y-${guide}`">
        <line
          class="value-guide"
          x1="0"
          :x2="contentWidth"
          :y1="valueToY(guide)"
          :y2="valueToY(guide)"
        />
        <text class="guide-label" x="7" :y="Math.max(9, valueToY(guide) - 4)">
          {{ Math.round(guide) }}
        </text>
      </g>
      <path class="lane-fill" :d="fillPath" />
      <path class="lane-line-shadow" :d="linePath" />
      <path class="lane-line" :d="linePath" />
    </svg>
    <button
      v-for="point in renderedPoints"
      v-show="expanded"
      :key="point.id"
      type="button"
      class="point-handle"
      :class="{ selected: point.id === selectedId }"
      :style="{
        left: `${positionToX(point.position)}px`,
        top: `${valueToY(point.value)}px`
      }"
      :aria-label="`${valueLabel} ${point.value.toFixed(2)} at ${point.position.toFixed(2)} ${positionLabel}`"
      @pointerdown="startDrag($event, point)"
      @click.stop="emit('select', point.id)"
    />
    <div v-if="!expanded" class="collapsed-rule" aria-hidden="true" />
  </div>
</template>

<style scoped>
.value-lane {
  --lane-color: var(--ui-domain-color-65a8ff);
  position: relative;
  min-width: 100%;
  overflow: hidden;
  border-bottom: 1px solid var(--line-strong);
  background: var(--daw-lane);
  cursor: crosshair;
  outline: none;
  user-select: none;
}
.value-lane:focus-visible {
  box-shadow: 0 0 0 1px var(--focus) inset;
}
.lane-graph {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
.vertical-guide {
  stroke: var(--daw-grid-line);
  stroke-width: 1;
}
.beat-guide {
  stroke: color-mix(in srgb, var(--daw-grid-line) 32%, transparent);
  stroke-width: 1;
}
.value-guide {
  stroke: color-mix(in srgb, var(--line-soft) 72%, transparent);
  stroke-width: 1;
  stroke-dasharray: 2 4;
}
.guide-label {
  fill: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  paint-order: stroke;
  stroke: var(--daw-lane);
  stroke-width: 3px;
}
.lane-fill {
  fill: color-mix(in srgb, var(--lane-color) 15%, transparent);
}
.lane-line-shadow {
  fill: none;
  stroke: color-mix(in srgb, var(--ui-domain-color-000) 62%, transparent);
  stroke-width: 4;
}
.lane-line {
  fill: none;
  stroke: var(--lane-color);
  stroke-width: 1.5;
  shape-rendering: geometricPrecision;
}
.point-handle {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  width: 9px;
  height: 9px;
  margin: 0;
  padding: 0;
  border: 2px solid var(--daw-lane);
  border-radius: 50%;
  background: var(--lane-color);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--lane-color) 66%, var(--ui-domain-color-000));
  transform: translate(-50%, -50%);
  cursor: grab;
}
.point-handle:hover,
.point-handle.selected {
  width: 11px;
  height: 11px;
  border-color: var(--ui-domain-color-f7fbff);
  box-shadow:
    0 0 0 2px var(--lane-color),
    0 0 8px color-mix(in srgb, var(--lane-color) 55%, transparent);
}
.point-handle:active {
  cursor: grabbing;
}
.point-handle:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 3px;
}
.value-lane.collapsed {
  cursor: default;
  background: color-mix(in srgb, var(--lane-color) 4%, var(--daw-ruler));
}
.collapsed-rule {
  position: absolute;
  top: 50%;
  right: 0;
  left: 0;
  height: 1px;
  background: color-mix(in srgb, var(--lane-color) 28%, var(--line-soft));
}
</style>
