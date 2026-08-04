import { computed, shallowRef, toValue, type MaybeRefOrGetter } from "vue"
import type { TempoMapSnapshot } from "@heron/contracts"
import { timelineXToTick } from "../../utils/timelineCoordinates"
import { barLengthTicksAtTick, barTicksThroughTick } from "../../utils/tempoMap"

interface ProjectEndDragOptions {
  endTick: MaybeRefOrGetter<number>
  tempoMap: MaybeRefOrGetter<TempoMapSnapshot>
  pixelsPerQuarter: MaybeRefOrGetter<number>
  commit: (endTick: number) => void
}

interface ActiveGesture {
  pointerId: number
  rulerLeft: number
}

export function snapProjectEndTick(map: TempoMapSnapshot, requestedTick: number): number {
  const requested = Math.max(1, Math.round(requestedTick))
  const searchEnd = requested + barLengthTicksAtTick(map, requested)
  const boundaries = barTicksThroughTick(map, searchEnd).filter((tick) => tick > 0)
  return boundaries.reduce(
    (nearest, tick) =>
      Math.abs(tick - requested) < Math.abs(nearest - requested) ? tick : nearest,
    boundaries[0] ?? barLengthTicksAtTick(map, 0)
  )
}

export function useProjectEndDrag(options: ProjectEndDragOptions) {
  const gesture = shallowRef<ActiveGesture | null>(null)
  const preview = shallowRef<number | null>(null)
  const active = computed(() => gesture.value !== null)

  function tickAtPointer(event: PointerEvent, rulerLeft: number): number {
    return snapProjectEndTick(
      toValue(options.tempoMap),
      timelineXToTick(
        toValue(options.tempoMap),
        Math.max(0, event.clientX - rulerLeft),
        toValue(options.pixelsPerQuarter)
      )
    )
  }

  function start(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement
    const ruler = target.closest<HTMLElement>(".ruler")
    if (!ruler) return
    target.setPointerCapture?.(event.pointerId)
    const rulerLeft = ruler.getBoundingClientRect().left
    gesture.value = { pointerId: event.pointerId, rulerLeft }
    preview.value = tickAtPointer(event, rulerLeft)
  }

  function update(event: PointerEvent): void {
    const current = gesture.value
    if (!current || event.pointerId !== current.pointerId) return
    preview.value = tickAtPointer(event, current.rulerLeft)
  }

  function finish(event: PointerEvent): void {
    if (!gesture.value || event.pointerId !== gesture.value.pointerId) return
    const value = preview.value
    gesture.value = null
    preview.value = null
    if (value !== null && value !== toValue(options.endTick)) options.commit(value)
  }

  function cancel(): void {
    gesture.value = null
    preview.value = null
  }

  return { active, preview, start, update, finish, cancel }
}
