import type { TempoMapSnapshot, TimeSignatureEventState } from "@yadaw/contracts"

export function tickToSeconds(map: TempoMapSnapshot, tick: number): number {
  let seconds = 0
  let previousTick = 0
  let beatsPerMinute = map.tempoEvents[0]?.beatsPerMinute ?? 120
  for (const event of map.tempoEvents.slice(1)) {
    if (event.tick >= tick) break
    seconds += (event.tick - previousTick) / map.ticksPerQuarter * 60 / beatsPerMinute
    previousTick = event.tick
    beatsPerMinute = event.beatsPerMinute
  }
  return seconds + (Math.max(previousTick, tick) - previousTick) /
    map.ticksPerQuarter * 60 / beatsPerMinute
}

export function secondsToTick(map: TempoMapSnapshot, seconds: number): number {
  let remaining = Math.max(0, seconds)
  let previousTick = 0
  let beatsPerMinute = map.tempoEvents[0]?.beatsPerMinute ?? 120
  for (const event of map.tempoEvents.slice(1)) {
    const segmentSeconds = (event.tick - previousTick) /
      map.ticksPerQuarter * 60 / beatsPerMinute
    if (remaining <= segmentSeconds) {
      return Math.round(previousTick + remaining * beatsPerMinute / 60 * map.ticksPerQuarter)
    }
    remaining -= segmentSeconds
    previousTick = event.tick
    beatsPerMinute = event.beatsPerMinute
  }
  return Math.round(previousTick + remaining * beatsPerMinute / 60 * map.ticksPerQuarter)
}

export function tempoAtTick(map: TempoMapSnapshot, tick: number): number {
  let current = map.tempoEvents[0]?.beatsPerMinute ?? 120
  for (const event of map.tempoEvents) {
    if (event.tick > tick) break
    current = event.beatsPerMinute
  }
  return current
}

export function timeSignatureAtTick(
  map: TempoMapSnapshot,
  tick: number
): TimeSignatureEventState {
  let current = map.timeSignatureEvents[0] ?? { tick: 0, numerator: 4, denominator: 4 }
  for (const event of map.timeSignatureEvents) {
    if (event.tick > tick) break
    current = event
  }
  return current
}

export function musicalPositionAtTick(
  map: TempoMapSnapshot,
  tick: number
): { bar: number; beat: number; tick: number } {
  let bar = 1
  let segmentStart = 0
  let signature = map.timeSignatureEvents[0] ?? { tick: 0, numerator: 4, denominator: 4 }
  for (const event of map.timeSignatureEvents.slice(1)) {
    if (event.tick > tick) break
    const ticksPerBar = signature.numerator * map.ticksPerQuarter * 4 / signature.denominator
    bar += Math.floor((event.tick - segmentStart) / ticksPerBar)
    segmentStart = event.tick
    signature = event
  }
  const ticksPerBeat = map.ticksPerQuarter * 4 / signature.denominator
  const ticksPerBar = signature.numerator * ticksPerBeat
  const inSegment = Math.max(0, tick - segmentStart)
  bar += Math.floor(inSegment / ticksPerBar)
  const inBar = inSegment % ticksPerBar
  return {
    bar,
    beat: Math.floor(inBar / ticksPerBeat) + 1,
    tick: Math.floor(inBar % ticksPerBeat)
  }
}
