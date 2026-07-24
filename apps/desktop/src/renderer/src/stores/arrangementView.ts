import { defineStore } from "pinia"
import { shallowRef } from "vue"

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

export const useArrangementViewStore = defineStore("arrangement-view", () => {
  const pixelsPerSecond = shallowRef(100)
  const trackHeight = shallowRef(104)
  const amplitudeScale = shallowRef(1)

  function zoomTime(direction: number): void {
    pixelsPerSecond.value = clamp(
      pixelsPerSecond.value * (direction > 0 ? 1.25 : 1 / 1.25),
      25,
      1_600
    )
  }
  function zoomTrack(direction: number): void {
    trackHeight.value = clamp(trackHeight.value + (direction > 0 ? 16 : -16), 72, 320)
  }
  function zoomAmplitude(direction: number): void {
    amplitudeScale.value = clamp(
      amplitudeScale.value * (direction > 0 ? Math.SQRT2 : 1 / Math.SQRT2),
      0.5,
      8
    )
  }
  function resetTime(): void { pixelsPerSecond.value = 100 }
  function resetTrack(): void { trackHeight.value = 104 }
  function resetAmplitude(): void { amplitudeScale.value = 1 }
  function reset(): void {
    resetTime()
    resetTrack()
    resetAmplitude()
  }

  return {
    pixelsPerSecond,
    trackHeight,
    amplitudeScale,
    zoomTime,
    zoomTrack,
    zoomAmplitude,
    resetTime,
    resetTrack,
    resetAmplitude,
    reset
  }
})
