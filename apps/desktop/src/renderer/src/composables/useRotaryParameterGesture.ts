import { readonly, shallowRef } from "vue"

export function useRotaryParameterGesture(options: {
  currentValue: () => number
  minimum: number
  maximum: number
  pixelsPerStep?: number
  preview: (value: number) => void
  commit: (value: number) => void
}) {
  const dragging = shallowRef(false)
  const dragValue = shallowRef(options.currentValue())
  const pixelsPerStep = options.pixelsPerStep ?? 2
  let pointerId: number | null = null
  let startY = 0
  let startValue = 0

  function clamp(value: number): number {
    return Math.max(options.minimum, Math.min(options.maximum, Math.round(value)))
  }

  function begin(event: PointerEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    pointerId = event.pointerId
    startY = event.clientY
    startValue = options.currentValue()
    dragValue.value = startValue
    dragging.value = true
    target.setPointerCapture?.(event.pointerId)
  }

  function move(event: PointerEvent): void {
    if (!dragging.value || event.pointerId !== pointerId) return
    event.preventDefault()
    const nextValue = clamp(startValue + (startY - event.clientY) / pixelsPerStep)
    if (nextValue === dragValue.value) return
    dragValue.value = nextValue
    options.preview(nextValue)
  }

  function end(event: PointerEvent): void {
    if (!dragging.value || event.pointerId !== pointerId) return
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    target.releasePointerCapture?.(event.pointerId)
    pointerId = null
    dragging.value = false
    options.commit(dragValue.value)
  }

  function cancel(event: PointerEvent): void {
    if (!dragging.value || event.pointerId !== pointerId) return
    const target = event.currentTarget as HTMLElement
    target.releasePointerCapture?.(event.pointerId)
    pointerId = null
    dragging.value = false
    dragValue.value = startValue
    options.preview(startValue)
  }

  return {
    dragging: readonly(dragging),
    dragValue: readonly(dragValue),
    begin,
    move,
    end,
    cancel
  }
}
