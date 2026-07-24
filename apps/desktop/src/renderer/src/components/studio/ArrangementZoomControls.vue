<script setup lang="ts">
import { Minus, Plus } from "@lucide/vue"

defineProps<{
  pixelsPerSecond: number
  trackHeight: number
  amplitudeScale: number
}>()
const emit = defineEmits<{
  zoomTime: [direction: number]
  zoomTrack: [direction: number]
  zoomAmplitude: [direction: number]
  resetTime: []
  resetTrack: []
  resetAmplitude: []
}>()
</script>

<template>
  <div class="zoom-controls" aria-label="Arrangement zoom controls">
    <div class="zoom-group">
      <span>TIME</span>
      <button aria-label="Zoom time out" @click="emit('zoomTime', -1)"><Minus :size="10" /></button>
      <button class="zoom-value" aria-label="Reset time zoom" @click="emit('resetTime')">{{ Math.round(pixelsPerSecond) }} px/s</button>
      <button aria-label="Zoom time in" @click="emit('zoomTime', 1)"><Plus :size="10" /></button>
    </div>
    <div class="zoom-group">
      <span>TRACK</span>
      <button aria-label="Reduce track height" @click="emit('zoomTrack', -1)"><Minus :size="10" /></button>
      <button class="zoom-value" aria-label="Reset track height" @click="emit('resetTrack')">{{ trackHeight }} px</button>
      <button aria-label="Increase track height" @click="emit('zoomTrack', 1)"><Plus :size="10" /></button>
    </div>
    <div class="zoom-group">
      <span>GAIN</span>
      <button aria-label="Reduce waveform amplitude" @click="emit('zoomAmplitude', -1)"><Minus :size="10" /></button>
      <button class="zoom-value" aria-label="Reset waveform amplitude" @click="emit('resetAmplitude')">{{ amplitudeScale.toFixed(1) }}×</button>
      <button aria-label="Increase waveform amplitude" @click="emit('zoomAmplitude', 1)"><Plus :size="10" /></button>
    </div>
  </div>
</template>

<style scoped>
.zoom-controls,.zoom-group{display:flex;align-items:center}.zoom-controls{gap:10px}.zoom-group{gap:2px}.zoom-group>span{margin-right:3px;color:#465368;font:6px var(--font-utility);letter-spacing:.09em}.zoom-group button{display:grid;place-items:center;height:20px;min-width:20px;padding:0;border:1px solid #2c3647;color:#69768a;background:#111824;cursor:pointer}.zoom-group button:first-of-type{border-radius:4px 0 0 4px}.zoom-group button:last-of-type{border-radius:0 4px 4px 0}.zoom-group button:hover,.zoom-group button:focus-visible{z-index:1;border-color:#756dcc;color:#d6d2ff;outline:none}.zoom-group .zoom-value{min-width:48px;padding:0 5px;color:#8995a8;font:6px var(--font-utility)}
</style>
