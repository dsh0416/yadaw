import type { TempoMapSnapshot } from "@yadaw/contracts"
import { secondsToTick, tickToSeconds } from "./tempoMap"

export function tickToTimelineX(
  map: TempoMapSnapshot,
  tick: number,
  pixelsPerQuarter: number
): number {
  return (tick / map.ticksPerQuarter) * pixelsPerQuarter
}

export function timelineXToTick(
  map: TempoMapSnapshot,
  x: number,
  pixelsPerQuarter: number
): number {
  if (pixelsPerQuarter <= 0) return 0
  return Math.max(0, Math.round((x / pixelsPerQuarter) * map.ticksPerQuarter))
}

export function secondsToTimelineX(
  map: TempoMapSnapshot,
  seconds: number,
  pixelsPerQuarter: number
): number {
  return tickToTimelineX(map, secondsToTick(map, seconds), pixelsPerQuarter)
}

export function timelineXToSeconds(
  map: TempoMapSnapshot,
  x: number,
  pixelsPerQuarter: number
): number {
  return tickToSeconds(map, timelineXToTick(map, x, pixelsPerQuarter))
}
