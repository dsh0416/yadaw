<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{
  durationSeconds: number
  tempo: number
  beatsPerBar: number
}>()

const emit = defineEmits<{
  seek: [seconds: number]
}>()

const barDuration = computed(() => 60 / props.tempo * props.beatsPerBar)
const marks = computed(() => {
  const count = Math.min(128, Math.ceil(props.durationSeconds / barDuration.value))
  return Array.from({ length: count }, (_, index) => ({
    bar: index + 1,
    left: index * barDuration.value / props.durationSeconds * 100
  }))
})

function seekFromPointer(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  if (bounds.width <= 0) return
  emit("seek", (event.clientX - bounds.left) / bounds.width * props.durationSeconds)
}
</script>

<template>
  <div class="ruler" aria-label="Timeline ruler" @pointerdown="seekFromPointer">
    <span
      v-for="mark in marks"
      :key="mark.bar"
      class="bar-mark"
      :style="{ left: `${mark.left}%` }"
    >
      {{ String(mark.bar).padStart(2, "0") }}
    </span>
  </div>
</template>

<style scoped>
.ruler{position:relative;overflow:hidden;border-bottom:1px solid var(--line-strong);background:#101620;cursor:text;user-select:none}.bar-mark{position:absolute;top:0;bottom:0;min-width:28px;padding:8px 0 0 7px;border-left:1px solid #293344;color:#6d788c;font:8px var(--font-utility);pointer-events:none}.bar-mark::after{position:absolute;top:15px;left:25%;width:1px;height:4px;background:#293344;box-shadow:7px 0 #293344,14px 0 #293344;content:""}
</style>
