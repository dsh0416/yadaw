<script setup lang="ts">
import { computed, shallowRef } from "vue"

const props = defineProps<{
  baseHeight: number
  scale: number
  trackName: string
}>()
const emit = defineEmits<{
  setScale: [scale: number]
  reset: []
}>()

const MIN_SCALE = 0.5
const MAX_SCALE = 4
const KEYBOARD_SCALE_STEP = 0.25
const dragStart = shallowRef<{
  pointerId: number
  clientY: number
  scale: number
} | null>(null)

const effectiveHeight = computed(() => props.baseHeight * props.scale)
const resizeLabel = computed(() =>
  `Resize ${props.trackName} track height; current scale ${props.scale.toFixed(2)} times`
)

function startResize(event: PointerEvent): void {
  dragStart.value = {
    pointerId: event.pointerId,
    clientY: event.clientY,
    scale: props.scale
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  event.preventDefault()
  event.stopPropagation()
}
function continueResize(event: PointerEvent): void {
  const start = dragStart.value
  if (!start || start.pointerId !== event.pointerId) return
  emit("setScale", start.scale + (event.clientY - start.clientY) / props.baseHeight)
}
function stopResize(event: PointerEvent): void {
  if (dragStart.value?.pointerId !== event.pointerId) return
  dragStart.value = null
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
}
function handleKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (event.key === "ArrowUp") emit("setScale", props.scale - KEYBOARD_SCALE_STEP)
  else if (event.key === "ArrowDown") emit("setScale", props.scale + KEYBOARD_SCALE_STEP)
  else if (event.key === "Home") emit("reset")
  else return
  event.preventDefault()
  event.stopPropagation()
}
</script>

<template>
  <span
    class="track-height-resize-handle"
    role="separator"
    aria-orientation="horizontal"
    :aria-label="resizeLabel"
    :aria-valuemin="Math.round(baseHeight * MIN_SCALE)"
    :aria-valuemax="Math.round(baseHeight * MAX_SCALE)"
    :aria-valuenow="Math.round(effectiveHeight)"
    tabindex="0"
    @click.stop
    @dblclick.stop="emit('reset')"
    @keydown="handleKeydown"
    @pointerdown="startResize"
    @pointermove="continueResize"
    @pointerup="stopResize"
    @pointercancel="stopResize"
  />
</template>

<style scoped>
.track-height-resize-handle{position:absolute;z-index:2;right:0;bottom:-3px;left:0;height:7px;cursor:row-resize;touch-action:none}.track-height-resize-handle::after{position:absolute;right:8px;bottom:3px;left:8px;height:1px;background:transparent;content:"";transition:background 100ms ease}.track-height-resize-handle:hover::after,.track-height-resize-handle:focus-visible::after{background:var(--accent-strong)}.track-height-resize-handle:focus-visible{outline:none}
</style>
