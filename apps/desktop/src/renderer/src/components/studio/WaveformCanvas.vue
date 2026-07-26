<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from "vue"
import { useResizeObserver } from "@vueuse/core"
import type { TempoMapSnapshot, WaveformDisplayMode, WaveformPeakWindow } from "@yadaw/contracts"
import { buildWarpedWaveformGeometry, buildWaveformGeometry } from "../../utils/waveform"
import { timelineXToSeconds } from "../../utils/timelineCoordinates"

const props = defineProps<{
  window: WaveformPeakWindow | null
  displayMode: WaveformDisplayMode
  amplitudeScale: number
  loading: boolean
  recording?: boolean
  tempoMap?: TempoMapSnapshot
  pixelsPerQuarter?: number
  timelineStartX?: number
  clipStartSeconds?: number
}>()

const canvas = useTemplateRef<HTMLCanvasElement>("canvas")
const size = { width: 0, height: 0 }
const accessibleLabel = computed(() => {
  if (props.loading && !props.window) return "Waveform loading"
  if (!props.window) return "Waveform unavailable"
  return `Waveform, ${props.window.channels} channels, ${props.window.frameCount} frames`
})

function draw(): void {
  const element = canvas.value
  if (!element) return
  const context = element.getContext("2d")
  if (!context) return
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, size.width || element.clientWidth)
  const height = Math.max(1, size.height || element.clientHeight)
  element.width = Math.round(width * ratio)
  element.height = Math.round(height * ratio)
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  if (!props.window) return
  const canWarp =
    props.tempoMap !== undefined &&
    props.pixelsPerQuarter !== undefined &&
    props.timelineStartX !== undefined &&
    props.clipStartSeconds !== undefined
  const geometry = canWarp
    ? buildWarpedWaveformGeometry(
        props.window,
        props.displayMode,
        width,
        height,
        props.amplitudeScale,
        (x) =>
          (timelineXToSeconds(props.tempoMap!, props.timelineStartX! + x, props.pixelsPerQuarter!) -
            props.clipStartSeconds!) *
          props.window!.sampleRate
      )
    : buildWaveformGeometry(props.window, props.displayMode, width, height, props.amplitudeScale)
  context.strokeStyle = props.recording ? "#ffb3be" : "#87a8b7"
  context.globalAlpha = 0.28
  context.lineWidth = 1
  context.beginPath()
  for (let lane = 0; lane < geometry.lanes; lane += 1) {
    const center = ((lane + 0.5) / geometry.lanes) * height
    context.moveTo(0, center)
    context.lineTo(width, center)
  }
  context.stroke()
  context.strokeStyle = props.recording ? "#ffd2d8" : "#b7e9fa"
  context.globalAlpha = 0.86
  context.lineWidth = 1
  context.beginPath()
  for (const line of geometry.lines) {
    context.moveTo(line.x, line.maximumY)
    context.lineTo(line.x, line.minimumY)
  }
  context.stroke()
}

useResizeObserver(canvas, (entries) => {
  const bounds = entries[0]?.contentRect
  if (!bounds) return
  size.width = bounds.width
  size.height = bounds.height
  draw()
})
watch(
  () => [
    props.window,
    props.displayMode,
    props.amplitudeScale,
    props.recording,
    props.tempoMap,
    props.pixelsPerQuarter,
    props.timelineStartX,
    props.clipStartSeconds
  ],
  () => void nextTick(draw),
  { immediate: true }
)
</script>

<template>
  <canvas ref="canvas" class="waveform-canvas" role="img" :aria-label="accessibleLabel" />
</template>

<style scoped>
.waveform-canvas {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
