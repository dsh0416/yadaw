<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{
  contentWidth: number
  pixelsPerSecond: number
  tempo: number
  beatsPerBar: number
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

function seekFromPointer(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  emit("seek", Math.max(0, (event.clientX - bounds.left) / props.pixelsPerSecond))
}
</script>

<template>
  <div class="ruler" :style="rulerStyle" aria-label="Timeline ruler" @pointerdown="seekFromPointer">
    <span v-for="mark in marks" :key="mark.bar" class="bar-mark" :style="{ left: `${mark.left}px` }">
      {{ String(mark.bar).padStart(2, "0") }}
    </span>
  </div>
</template>

<style scoped>
.ruler{position:relative;height:27px;overflow:hidden;border-bottom:1px solid var(--line-strong);background:#101620;cursor:text;user-select:none}.bar-mark{position:absolute;top:0;bottom:0;min-width:28px;padding:8px 0 0 7px;border-left:1px solid #293344;color:#6d788c;font:8px var(--font-utility);pointer-events:none}.bar-mark::after{position:absolute;top:15px;left:25%;width:1px;height:4px;background:#293344;box-shadow:7px 0 #293344,14px 0 #293344;content:""}
</style>
