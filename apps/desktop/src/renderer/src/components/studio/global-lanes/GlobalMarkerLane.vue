<script setup lang="ts">
import { computed, shallowRef, useTemplateRef } from "vue"

export interface GlobalMarkerLanePoint {
  id: string
  position: number
  label: string
  lockTime?: boolean
  lockRemoval?: boolean
}

const props = defineProps<{
  points: GlobalMarkerLanePoint[]
  selectedId: string | null
  contentWidth: number
  pixelsPerUnit: number
  height: number
  beatGuides: number[]
  verticalGuides: number[]
  color: string
  valueLabel: string
  positionLabel: string
}>()

const emit = defineEmits<{
  create: [position: number]
  update: [id: string, position: number]
  remove: [id: string]
  select: [id: string | null]
}>()

const lane = useTemplateRef<HTMLElement>("lane")
const drag = shallowRef<{ id: string; position: number } | null>(null)
const sortedPoints = computed(() =>
  [...props.points].sort((left, right) => left.position - right.position)
)
const renderedPoints = computed(() =>
  sortedPoints.value.map((point) =>
    drag.value?.id === point.id ? { ...point, position: drag.value.position } : point
  )
)
const segments = computed(() =>
  renderedPoints.value.map((point, index) => ({
    ...point,
    left: positionToX(point.position),
    width: Math.max(
      0,
      (renderedPoints.value[index + 1]
        ? positionToX(renderedPoints.value[index + 1]!.position)
        : props.contentWidth) - positionToX(point.position)
    )
  }))
)

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function positionToX(position: number): number {
  return position * props.pixelsPerUnit
}

function positionFromPointer(event: PointerEvent | MouseEvent): number {
  const bounds = lane.value?.getBoundingClientRect()
  if (!bounds) return 0
  return clamp(event.clientX - bounds.left, 0, props.contentWidth) / props.pixelsPerUnit
}

function createPoint(event: MouseEvent): void {
  emit("create", positionFromPointer(event))
}

function startDrag(event: PointerEvent, point: GlobalMarkerLanePoint): void {
  event.preventDefault()
  event.stopPropagation()
  emit("select", point.id)
  drag.value = { id: point.id, position: point.position }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function updateDrag(event: PointerEvent): void {
  const current = drag.value
  if (!current) return
  const source = props.points.find((point) => point.id === current.id)
  if (!source) return
  drag.value = {
    id: current.id,
    position: source.lockTime ? source.position : positionFromPointer(event)
  }
}

function finishDrag(): void {
  const current = drag.value
  if (!current) return
  drag.value = null
  emit("update", current.id, current.position)
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
    class="marker-lane"
    :style="{
      width: `${contentWidth}px`,
      height: `${height}px`,
      '--lane-color': color
    }"
    tabindex="0"
    role="application"
    :aria-label="`${valueLabel} global track editor. Double-click to add an event.`"
    @dblclick="createPoint"
    @pointermove="updateDrag"
    @pointerup="finishDrag"
    @pointercancel="finishDrag"
    @keydown="handleKeydown"
    @pointerdown.self="emit('select', null)"
  >
    <span
      v-for="guide in beatGuides"
      :key="`beat-${guide}`"
      class="beat-guide"
      :style="{ left: `${guide}px` }"
      aria-hidden="true"
    />
    <span
      v-for="guide in verticalGuides"
      :key="guide"
      class="vertical-guide"
      :style="{ left: `${guide}px` }"
      aria-hidden="true"
    />
    <span
      v-for="segment in segments"
      :key="`segment-${segment.id}`"
      class="event-segment"
      :class="{ selected: segment.id === selectedId }"
      :style="{ left: `${segment.left}px`, width: `${segment.width}px` }"
      aria-hidden="true"
    >
      <b>{{ segment.label }}</b>
    </span>
    <button
      v-for="point in renderedPoints"
      :key="point.id"
      type="button"
      class="event-handle"
      :class="{ selected: point.id === selectedId }"
      :style="{ left: `${positionToX(point.position)}px` }"
      :aria-label="`${valueLabel} ${point.label} at ${point.position.toFixed(2)} ${positionLabel}`"
      @pointerdown="startDrag($event, point)"
      @click.stop="emit('select', point.id)"
    />
  </div>
</template>

<style scoped>
.marker-lane {
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
.marker-lane:focus-visible {
  box-shadow: 0 0 0 1px var(--focus) inset;
}
.vertical-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--daw-grid-line);
  pointer-events: none;
}
.beat-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--daw-grid-line) 32%, transparent);
  pointer-events: none;
}
.event-segment {
  position: absolute;
  top: 11px;
  bottom: 10px;
  overflow: hidden;
  border-top: 1px solid color-mix(in srgb, var(--lane-color) 64%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--lane-color) 35%, transparent);
  background: color-mix(in srgb, var(--lane-color) 10%, transparent);
  pointer-events: none;
}
.event-segment.selected {
  background: color-mix(in srgb, var(--lane-color) 19%, transparent);
}
.event-segment b {
  display: block;
  padding: 6px 10px;
  overflow: hidden;
  color: color-mix(in srgb, var(--lane-color) 78%, var(--text-primary));
  font: var(--ui-type-weight-bold) var(--ui-type-size-control) var(--ui-type-family-data);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.event-handle {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  top: 6px;
  bottom: 6px;
  width: 7px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--daw-lane);
  border-radius: 2px;
  background: var(--lane-color);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--lane-color) 55%, var(--ui-domain-color-000));
  transform: translateX(-50%);
  cursor: ew-resize;
}
.event-handle:hover,
.event-handle.selected {
  width: 9px;
  border-color: var(--ui-domain-color-f7fbff);
  box-shadow:
    0 0 0 2px var(--lane-color),
    0 0 8px color-mix(in srgb, var(--lane-color) 55%, transparent);
}
.event-handle:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 3px;
}
</style>
