import { shallowRef } from "vue"

export interface ParameterGestureOptions {
  currentValue: () => number
  preview: (value: number) => void
  commit: (value: number) => void
}

function inputFrom(event: Event): HTMLInputElement {
  return event.currentTarget as HTMLInputElement
}

export function useParameterGesture(options: ParameterGestureOptions) {
  const active = shallowRef(false)
  const gestureValue = shallowRef(options.currentValue())
  let startValue: number | null = null
  let cancelled = false

  function begin(): void {
    if (!active.value) {
      startValue = options.currentValue()
      gestureValue.value = startValue
    }
    active.value = true
    cancelled = false
  }

  function preview(event: Event): void {
    begin()
    gestureValue.value = Number(inputFrom(event).value)
    options.preview(gestureValue.value)
  }

  function commit(event: Event): void {
    const input = inputFrom(event)
    if (cancelled) {
      input.value = String(startValue ?? options.currentValue())
      cancelled = false
      startValue = null
      active.value = false
      return
    }
    options.commit(gestureValue.value)
    startValue = null
    active.value = false
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || startValue === null) return
    event.preventDefault()
    event.stopPropagation()
    cancelled = true
    gestureValue.value = startValue
    options.preview(gestureValue.value)
    inputFrom(event).value = String(startValue)
    active.value = false
  }

  function reset(value: number): void {
    startValue = null
    cancelled = false
    gestureValue.value = value
    active.value = false
    options.commit(value)
  }

  return { active, gestureValue, begin, preview, commit, keydown, reset }
}
