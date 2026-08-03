import { useStorage } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const MIN_TRACK_SCALE = 0.5
const MAX_TRACK_SCALE = 4

export const useArrangementViewStore = defineStore("arrangement-view", () => {
  const pixelsPerQuarter = shallowRef(50)
  const trackHeight = shallowRef(104)
  const trackScales = shallowRef<Record<string, number>>({})
  const amplitudeScale = shallowRef(1)
  const globalTracksExpanded = useStorage("heron.arrangement.global-tracks-expanded.v1", true)

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
  function setGlobalTracksExpanded(expanded: boolean): void {
    globalTracksExpanded.value = expanded
  }
  function toggleGlobalTracks(): void {
    setGlobalTracksExpanded(!globalTracksExpanded.value)
  }
  function reset(): void {
    resetTime()
    resetTrack()
    trackScales.value = {}
    resetAmplitude()
    setGlobalTracksExpanded(true)
  }

  return {
    pixelsPerQuarter,
    trackHeight,
    trackScales,
    amplitudeScale,
    globalTracksExpanded,
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
    setGlobalTracksExpanded,
    toggleGlobalTracks,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useArrangementViewStore, import.meta.hot))
}
