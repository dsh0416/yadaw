import { computed, shallowRef, toValue } from "vue"
import type { MaybeRefOrGetter } from "vue"
import type { TempoMapSnapshot, TransportLoopRange } from "@heron/contracts"
import { timelineXToTick } from "../../utils/timelineCoordinates"
import { previewCycleRange, type CycleRangeGesture } from "../../utils/cycleRange"

interface CycleRangeDragOptions {
  range: MaybeRefOrGetter<TransportLoopRange | null>
  tempoMap: MaybeRefOrGetter<TempoMapSnapshot>
  pixelsPerQuarter: MaybeRefOrGetter<number>
  commit: (range: TransportLoopRange) => void
}

interface ActiveGesture {
  mode: CycleRangeGesture
  pointerId: number
  laneLeft: number
  anchorTick: number
  initialRange: TransportLoopRange | null
}

export function useCycleRangeDrag(options: CycleRangeDragOptions) {
  const gesture = shallowRef<ActiveGesture | null>(null)
  const preview = shallowRef<TransportLoopRange | null>(null)
  const active = computed(() => gesture.value !== null)

  function tickAtPointer(event: PointerEvent, laneLeft: number): number {
    return timelineXToTick(
      toValue(options.tempoMap),
      Math.max(0, event.clientX - laneLeft),
      toValue(options.pixelsPerQuarter)
    )
  }

  function start(event: PointerEvent, mode: CycleRangeGesture): void {
    const target = event.currentTarget as HTMLElement
    const lane = target.classList.contains("cycle-lane")
      ? target
      : target.closest<HTMLElement>(".cycle-lane")
    if (!lane) return
    target.setPointerCapture?.(event.pointerId)
    const laneLeft = lane.getBoundingClientRect().left
    const anchorTick = tickAtPointer(event, laneLeft)
    const initialRange = toValue(options.range)
    gesture.value = { mode, pointerId: event.pointerId, laneLeft, anchorTick, initialRange }
    preview.value = previewCycleRange(
      toValue(options.tempoMap),
      initialRange,
      mode,
      anchorTick,
      anchorTick
    )
  }

  function update(event: PointerEvent): void {
    const current = gesture.value
    if (!current || event.pointerId !== current.pointerId) return
    preview.value = previewCycleRange(
      toValue(options.tempoMap),
      current.initialRange,
      current.mode,
      current.anchorTick,
      tickAtPointer(event, current.laneLeft)
    )
  }

  function finish(event: PointerEvent): void {
    if (!gesture.value || event.pointerId !== gesture.value.pointerId) return
    const value = preview.value
    gesture.value = null
    preview.value = null
    if (value) options.commit(value)
  }

  function cancel(): void {
    gesture.value = null
    preview.value = null
  }

  return { active, preview, start, update, finish, cancel }
}
