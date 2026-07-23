<script setup lang="ts">
import { computed } from "vue"
import type { TimelineClip } from "../../stores/transport"

const props = defineProps<{
  clip: TimelineClip
  timelineDurationSeconds: number
  selected: boolean
  recording?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const clipStyle = computed(() => ({
  left: `${props.clip.startSeconds / props.timelineDurationSeconds * 100}%`,
  width: `max(${props.clip.durationSeconds / props.timelineDurationSeconds * 100}%, 12px)`
}))

const waveform = computed(() => {
  let seed = [...props.clip.id].reduce((value, character) => value + character.charCodeAt(0), 17)
  return Array.from({ length: 54 }, (_, index) => {
    seed = (seed * 9301 + 49297 + index) % 233280
    return 18 + seed / 233280 * 72
  })
})
</script>

<template>
  <button
    :class="['audio-clip', { selected, recording }]"
    :style="clipStyle"
    :aria-label="`${recording ? 'Recording' : 'Audio clip'} ${clip.name}`"
    :aria-pressed="selected"
    @pointerdown.stop
    @click.stop="emit('select', clip.id)"
    @dblclick.stop="emit('select', clip.id)"
  >
    <span class="clip-heading">
      <b>{{ clip.name }}</b>
      <small>{{ recording ? "CAPTURING" : `${clip.channels} CH · ${(clip.durationSeconds).toFixed(1)} S` }}</small>
    </span>
    <span class="waveform" aria-hidden="true">
      <i v-for="(height, index) in waveform" :key="index" :style="{ height: `${height}%` }" />
    </span>
  </button>
</template>

<style scoped>
.audio-clip{position:absolute;z-index:2;top:9px;bottom:9px;display:block;min-width:12px;overflow:hidden;padding:0;border:1px solid #716be0;border-radius:4px;color:#f0efff;background:linear-gradient(180deg,#4b47a8ed,#283373ed);box-shadow:0 1px 0 #ffffff24 inset,0 7px 18px #02040a55;cursor:pointer;text-align:left}.audio-clip:hover{border-color:#a7a1ff;filter:brightness(1.08)}.audio-clip:focus-visible{outline:2px solid #d2ceff;outline-offset:-3px}.audio-clip.selected{z-index:3;border-color:#e4e2ff;box-shadow:0 0 0 2px #a49cff99 inset,0 0 20px #8179ff66}.audio-clip.recording{border-color:#ff6d7d;background:linear-gradient(180deg,#a23850ed,#59283fed);box-shadow:0 0 18px #ff65774d}.clip-heading{position:relative;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:6px 7px 0;white-space:nowrap}.clip-heading b{overflow:hidden;font-size:8px;font-weight:650;text-overflow:ellipsis}.clip-heading small{flex:none;color:#c2c0f4;font:6px var(--font-utility);letter-spacing:.06em}.recording .clip-heading small{color:#ffd4da}.waveform{position:absolute;right:6px;bottom:6px;left:6px;display:flex;height:40%;align-items:center;gap:2px;opacity:.76}.waveform i{min-width:1px;flex:1;border-radius:1px;background:#b7e9fa}.recording .waveform i{background:#ffd7dd}
</style>
