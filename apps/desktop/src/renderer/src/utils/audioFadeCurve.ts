export type AudioFadeCurveEdge = "in" | "out"

const FADE_CURVE_SIZE = 100
const FADE_CURVE_SEGMENTS = 24

function formatCoordinate(value: number): string {
  return Number(value.toFixed(3)).toString()
}

export function createEqualPowerFadeCurvePath(edge: AudioFadeCurveEdge): string {
  return Array.from({ length: FADE_CURVE_SEGMENTS + 1 }, (_, index) => {
    const progress = index / FADE_CURVE_SEGMENTS
    const gain = Math.sqrt(edge === "in" ? progress : 1 - progress)
    const x = progress * FADE_CURVE_SIZE
    const y = (1 - gain) * FADE_CURVE_SIZE
    return `${index === 0 ? "M" : "L"} ${formatCoordinate(x)} ${formatCoordinate(y)}`
  }).join(" ")
}

export function createEqualPowerFadeShadePath(edge: AudioFadeCurveEdge): string {
  return `${createEqualPowerFadeCurvePath(edge)} L ${FADE_CURVE_SIZE} 0 L 0 0 Z`
}
