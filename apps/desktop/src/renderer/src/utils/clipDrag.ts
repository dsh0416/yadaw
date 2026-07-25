export interface TrackLaneBounds {
  trackId: string
  top: number
  bottom: number
}

export function findNearestTrackId(
  lanes: readonly TrackLaneBounds[],
  clientY: number
): string | null {
  if (lanes.length === 0) return null

  const containingLane = lanes.find(({ top, bottom }) => clientY >= top && clientY < bottom)
  if (containingLane) return containingLane.trackId

  let nearestTrackId = lanes[0]!.trackId
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const lane of lanes) {
    const distance = clientY < lane.top
      ? lane.top - clientY
      : clientY - lane.bottom
    if (distance < nearestDistance) {
      nearestTrackId = lane.trackId
      nearestDistance = distance
    }
  }
  return nearestTrackId
}

export function clipStartSecondsFromPointer(
  clientX: number,
  contentLeft: number,
  tempoMap: TempoMapSnapshot,
  pixelsPerQuarter: number,
  dragOffsetPixels: number
): number {
  return timelineXToSeconds(
    tempoMap,
    Math.max(0, clientX - contentLeft - dragOffsetPixels),
    pixelsPerQuarter
  )
}
import type { TempoMapSnapshot } from "@yadaw/contracts"
import { timelineXToSeconds } from "./timelineCoordinates"
