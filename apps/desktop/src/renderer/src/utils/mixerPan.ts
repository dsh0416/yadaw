export function normalizedToPanUnits(value: number): number {
  const normalized = Math.max(-1, Math.min(1, value))
  return Math.round(normalized < 0 ? normalized * 64 : normalized * 63)
}

export function panUnitsToNormalized(value: number): number {
  const units = Math.max(-64, Math.min(63, Math.round(value)))
  return units < 0 ? units / 64 : units / 63
}

export function panLabelFromNormalized(value: number): string {
  const units = normalizedToPanUnits(value)
  if (units === 0) return "C"
  return units < 0 ? `L${Math.abs(units)}` : `R${units}`
}
