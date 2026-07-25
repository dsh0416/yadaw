export interface ParameterGestureOptions {
  currentValue: () => number
  preview: (value: number) => void
  commit: (value: number) => void
}

function inputFrom(event: Event): HTMLInputElement {
  return event.currentTarget as HTMLInputElement
}

export function useParameterGesture(options: ParameterGestureOptions) {
  let startValue: number | null = null
  let cancelled = false

  function begin(): void {
    startValue ??= options.currentValue()
    cancelled = false
  }

  function preview(event: Event): void {
    begin()
    options.preview(Number(inputFrom(event).value))
  }

  function commit(event: Event): void {
    const input = inputFrom(event)
    if (cancelled) {
      input.value = String(startValue ?? options.currentValue())
      cancelled = false
      startValue = null
      return
    }
    options.commit(Number(input.value))
    startValue = null
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || startValue === null) return
    event.preventDefault()
    event.stopPropagation()
    cancelled = true
    options.preview(startValue)
    inputFrom(event).value = String(startValue)
  }

  function reset(value: number): void {
    startValue = null
    cancelled = false
    options.commit(value)
  }

  return { begin, preview, commit, keydown, reset }
}
