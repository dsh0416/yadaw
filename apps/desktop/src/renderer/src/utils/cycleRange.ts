import type { TempoMapSnapshot, TransportLoopRange } from "@yadaw/contracts"
import { barLengthTicksAtTick, barTicksThroughTick, timeSignatureAtTick } from "./tempoMap"

export type CycleRangeGesture = "create" | "resize-start" | "resize-end" | "move"

export function beatLengthTicksAtTick(map: TempoMapSnapshot, tick: number): number {
  const signature = timeSignatureAtTick(map, tick)
  return Math.max(1, Math.round((map.ticksPerQuarter * 4) / signature.denominator))
}

export function snapTickToBeat(map: TempoMapSnapshot, requestedTick: number): number {
  const tick = Math.max(0, Math.round(requestedTick))
  const signature = timeSignatureAtTick(map, tick)
  const beatLength = beatLengthTicksAtTick(map, tick)
  const snapped = signature.tick + Math.round((tick - signature.tick) / beatLength) * beatLength
  const nextSignature = map.timeSignatureEvents.find((event) => event.tick > signature.tick)
  if (!nextSignature || snapped < nextSignature.tick) return Math.max(0, snapped)
  return Math.abs(tick - nextSignature.tick) < Math.abs(tick - (snapped - beatLength))
    ? nextSignature.tick
    : snapped - beatLength
}

export function defaultCycleRange(map: TempoMapSnapshot, playheadTick: number): TransportLoopRange {
  const startTick = barTicksThroughTick(map, Math.max(0, playheadTick)).at(-1) ?? 0
  const fallbackEnd = startTick + barLengthTicksAtTick(map, startTick)
  const endTick =
    barTicksThroughTick(map, fallbackEnd + barLengthTicksAtTick(map, fallbackEnd)).find(
      (tick) => tick > startTick
    ) ?? fallbackEnd
  return { startTick, endTick }
}

export function previewCycleRange(
  map: TempoMapSnapshot,
  range: TransportLoopRange | null,
  gesture: CycleRangeGesture,
  anchorTick: number,
  requestedTick: number
): TransportLoopRange {
  const anchor = snapTickToBeat(map, anchorTick)
  const current = snapTickToBeat(map, requestedTick)
  if (gesture === "create" || !range) {
    const startTick = Math.min(anchor, current)
    const minimum = beatLengthTicksAtTick(map, startTick)
    return { startTick, endTick: Math.max(Math.max(anchor, current), startTick + minimum) }
  }
  if (gesture === "move") {
    const length = range.endTick - range.startTick
    const startTick = Math.max(0, range.startTick + current - anchor)
    return { startTick, endTick: startTick + length }
  }
  if (gesture === "resize-start") {
    const minimum = beatLengthTicksAtTick(map, current)
    return { ...range, startTick: Math.max(0, Math.min(current, range.endTick - minimum)) }
  }
  const minimum = beatLengthTicksAtTick(map, range.startTick)
  return { ...range, endTick: Math.max(current, range.startTick + minimum) }
}
