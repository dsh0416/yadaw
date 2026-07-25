<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{
  pixelsPerSecond: number
  trackHeight: number
  amplitudeScale: number
}>()
const emit = defineEmits<{
  setTime: [pixelsPerSecond: number]
  setTrack: [height: number]
  setAmplitude: [scale: number]
  resetTime: []
  resetTrack: []
  resetAmplitude: []
}>()

const SLIDER_MAX = 100
const TIME_MIN = 25
const TIME_MAX = 1_600
const TRACK_MIN = 72
const TRACK_MAX = 320
const AMPLITUDE_MIN = 0.5
const AMPLITUDE_MAX = 8

const timePosition = computed(() =>
  logarithmicPosition(props.pixelsPerSecond, TIME_MIN, TIME_MAX)
)
const trackPosition = computed(() =>
  linearPosition(props.trackHeight, TRACK_MIN, TRACK_MAX)
)
const amplitudePosition = computed(() =>
  logarithmicPosition(props.amplitudeScale, AMPLITUDE_MIN, AMPLITUDE_MAX)
)

function clampPosition(value: number): number {
  return Math.min(SLIDER_MAX, Math.max(0, value))
}
function linearPosition(value: number, minimum: number, maximum: number): number {
  return clampPosition((value - minimum) / (maximum - minimum) * SLIDER_MAX)
}
function logarithmicPosition(value: number, minimum: number, maximum: number): number {
  return clampPosition(Math.log(value / minimum) / Math.log(maximum / minimum) * SLIDER_MAX)
}
function linearValue(position: number, minimum: number, maximum: number): number {
  return minimum + clampPosition(position) / SLIDER_MAX * (maximum - minimum)
}
function logarithmicValue(position: number, minimum: number, maximum: number): number {
  return minimum * (maximum / minimum) ** (clampPosition(position) / SLIDER_MAX)
}
function inputPosition(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}
function setTime(event: Event): void {
  emit("setTime", logarithmicValue(inputPosition(event), TIME_MIN, TIME_MAX))
}
function setTrack(event: Event): void {
  emit("setTrack", Math.round(linearValue(inputPosition(event), TRACK_MIN, TRACK_MAX)))
}
function setAmplitude(event: Event): void {
  emit("setAmplitude", logarithmicValue(inputPosition(event), AMPLITUDE_MIN, AMPLITUDE_MAX))
}
</script>

<template>
  <div class="zoom-controls" aria-label="Arrangement zoom controls">
    <label class="zoom-control">
      <span>TIME</span>
      <input
        type="range"
        min="0"
        :max="SLIDER_MAX"
        step="1"
        :value="timePosition"
        :style="{ '--zoom-fill': `${timePosition}%` }"
        aria-label="Time zoom"
        :aria-valuetext="`${Math.round(pixelsPerSecond)} pixels per second`"
        title="Double-click to reset time zoom"
        @input="setTime"
        @dblclick="emit('resetTime')"
      />
    </label>
    <label class="zoom-control">
      <span>TRACK</span>
      <input
        type="range"
        min="0"
        :max="SLIDER_MAX"
        step="1"
        :value="trackPosition"
        :style="{ '--zoom-fill': `${trackPosition}%` }"
        aria-label="Track height"
        :aria-valuetext="`${trackHeight} pixels`"
        title="Double-click to reset track height"
        @input="setTrack"
        @dblclick="emit('resetTrack')"
      />
    </label>
    <label class="zoom-control">
      <span>GAIN</span>
      <input
        type="range"
        min="0"
        :max="SLIDER_MAX"
        step="1"
        :value="amplitudePosition"
        :style="{ '--zoom-fill': `${amplitudePosition}%` }"
        aria-label="Waveform gain"
        :aria-valuetext="`${amplitudeScale.toFixed(1)} times`"
        title="Double-click to reset waveform gain"
        @input="setAmplitude"
        @dblclick="emit('resetAmplitude')"
      />
    </label>
  </div>
</template>

<style scoped>
.zoom-controls{display:flex;align-items:center;justify-content:flex-end;gap:14px}.zoom-control{display:grid;grid-template-columns:auto 86px;align-items:center;gap:7px}.zoom-control>span{color:var(--text-faint);font:650 6px var(--font-utility);letter-spacing:.1em}.zoom-control input{--zoom-fill:0%;width:86px;height:14px;margin:0;appearance:none;background:transparent;cursor:pointer}.zoom-control input::-webkit-slider-runnable-track{height:3px;border-radius:0;background:linear-gradient(to right,var(--accent) 0 var(--zoom-fill),var(--line-strong) var(--zoom-fill) 100%)}.zoom-control input::-webkit-slider-thumb{width:7px;height:13px;margin-top:-5px;border:1px solid var(--text-muted);border-radius:1px;appearance:none;background:var(--daw-control);box-shadow:0 0 0 1px var(--surface-1)}.zoom-control input:hover::-webkit-slider-thumb{border-color:var(--text-primary)}.zoom-control input:focus-visible{outline:none}.zoom-control input:focus-visible::-webkit-slider-thumb{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 28%,transparent)}.zoom-control input::-moz-range-track{height:3px;border-radius:0;background:var(--line-strong)}.zoom-control input::-moz-range-progress{height:3px;background:var(--accent)}.zoom-control input::-moz-range-thumb{width:7px;height:13px;border:1px solid var(--text-muted);border-radius:1px;background:var(--daw-control);box-shadow:0 0 0 1px var(--surface-1)}.zoom-control input:focus-visible::-moz-range-thumb{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 28%,transparent)}
</style>
