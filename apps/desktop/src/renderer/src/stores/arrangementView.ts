import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const MIN_TRACK_SCALE = 0.5
const MAX_TRACK_SCALE = 4
const TEMPO_LANE_EXPANDED_HEIGHT = 112
const GLOBAL_LANE_EXPANDED_HEIGHT = 64
const GLOBAL_LANE_COLLAPSED_HEIGHT = 30

export const useArrangementViewStore = defineStore("arrangement-view", () => {
  const pixelsPerQuarter = shallowRef(50)
  const trackHeight = shallowRef(104)
  const trackScales = shallowRef<Record<string, number>>({})
  const amplitudeScale = shallowRef(1)
  const tempoLaneExpanded = shallowRef(true)
  const tempoLaneHeight = shallowRef(TEMPO_LANE_EXPANDED_HEIGHT)
  const meterLaneExpanded = shallowRef(true)
  const meterLaneHeight = shallowRef(GLOBAL_LANE_EXPANDED_HEIGHT)
  const keyLaneExpanded = shallowRef(true)
  const keyLaneHeight = shallowRef(GLOBAL_LANE_EXPANDED_HEIGHT)

  function setTimeZoom(value: number): void {
    pixelsPerQuarter.value = clamp(value, 12.5, 800)
  }
  function zoomTime(direction: number): void {
    setTimeZoom(pixelsPerQuarter.value * (direction > 0 ? 1.25 : 1 / 1.25))
  }
  function setTrackHeight(value: number): void {
    trackHeight.value = clamp(value, 72, 320)
  }
  function zoomTrack(direction: number): void {
    setTrackHeight(trackHeight.value + (direction > 0 ? 16 : -16))
  }
  function trackScale(trackId: string): number {
    return trackScales.value[trackId] ?? 1
  }
  function effectiveTrackHeight(trackId: string): number {
    return trackHeight.value * trackScale(trackId)
  }
  function setTrackScale(trackId: string, scale: number): void {
    const nextScale = clamp(scale, MIN_TRACK_SCALE, MAX_TRACK_SCALE)
    const nextScales = { ...trackScales.value }
    if (nextScale === 1) delete nextScales[trackId]
    else nextScales[trackId] = nextScale
    trackScales.value = nextScales
  }
  function resetTrackScale(trackId: string): void {
    setTrackScale(trackId, 1)
  }
  function setAmplitudeScale(value: number): void {
    amplitudeScale.value = clamp(value, 0.5, 8)
  }
  function zoomAmplitude(direction: number): void {
    setAmplitudeScale(amplitudeScale.value * (direction > 0 ? Math.SQRT2 : 1 / Math.SQRT2))
  }
  function resetTime(): void {
    pixelsPerQuarter.value = 50
  }
  function resetTrack(): void {
    trackHeight.value = 104
  }
  function resetAmplitude(): void {
    amplitudeScale.value = 1
  }
  function setTempoLaneExpanded(expanded: boolean): void {
    tempoLaneExpanded.value = expanded
    tempoLaneHeight.value = expanded ? TEMPO_LANE_EXPANDED_HEIGHT : GLOBAL_LANE_COLLAPSED_HEIGHT
  }
  function toggleTempoLane(): void {
    setTempoLaneExpanded(!tempoLaneExpanded.value)
  }
  function setMeterLaneExpanded(expanded: boolean): void {
    meterLaneExpanded.value = expanded
    meterLaneHeight.value = expanded ? GLOBAL_LANE_EXPANDED_HEIGHT : GLOBAL_LANE_COLLAPSED_HEIGHT
  }
  function toggleMeterLane(): void {
    setMeterLaneExpanded(!meterLaneExpanded.value)
  }
  function setKeyLaneExpanded(expanded: boolean): void {
    keyLaneExpanded.value = expanded
    keyLaneHeight.value = expanded ? GLOBAL_LANE_EXPANDED_HEIGHT : GLOBAL_LANE_COLLAPSED_HEIGHT
  }
  function toggleKeyLane(): void {
    setKeyLaneExpanded(!keyLaneExpanded.value)
  }
  function reset(): void {
    resetTime()
    resetTrack()
    trackScales.value = {}
    resetAmplitude()
    setTempoLaneExpanded(true)
    setMeterLaneExpanded(true)
    setKeyLaneExpanded(true)
  }

  return {
    pixelsPerQuarter,
    trackHeight,
    trackScales,
    amplitudeScale,
    tempoLaneExpanded,
    tempoLaneHeight,
    meterLaneExpanded,
    meterLaneHeight,
    keyLaneExpanded,
    keyLaneHeight,
    setTimeZoom,
    zoomTime,
    setTrackHeight,
    zoomTrack,
    trackScale,
    effectiveTrackHeight,
    setTrackScale,
    resetTrackScale,
    setAmplitudeScale,
    zoomAmplitude,
    resetTime,
    resetTrack,
    resetAmplitude,
    setTempoLaneExpanded,
    toggleTempoLane,
    setMeterLaneExpanded,
    toggleMeterLane,
    setKeyLaneExpanded,
    toggleKeyLane,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useArrangementViewStore, import.meta.hot))
}
