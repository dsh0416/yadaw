export interface MixerDbScaleMark {
  value: number
  label: string
  position: number
  emphasis?: boolean
}

export const FADER_MIN_DB = -90
export const FADER_MAX_DB = 12
export const METER_MIN_DB = -60
export const METER_MAX_DB = 0

export function dbToLevelPercent(db: number, minDb: number, maxDb: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.min(100, Math.max(0, ((db - minDb) / (maxDb - minDb)) * 100))
}

function scaleMark(
  value: number,
  label: string,
  minDb: number,
  maxDb: number,
  emphasis = false
): MixerDbScaleMark {
  return {
    value,
    label,
    position: 100 - dbToLevelPercent(value, minDb, maxDb),
    emphasis
  }
}

export const FADER_SCALE_MARKS: readonly MixerDbScaleMark[] = [
  scaleMark(12, "+12", FADER_MIN_DB, FADER_MAX_DB),
  scaleMark(0, "0", FADER_MIN_DB, FADER_MAX_DB, true),
  scaleMark(-12, "−12", FADER_MIN_DB, FADER_MAX_DB),
  scaleMark(-30, "−30", FADER_MIN_DB, FADER_MAX_DB),
  scaleMark(-60, "−60", FADER_MIN_DB, FADER_MAX_DB),
  scaleMark(-90, "−∞", FADER_MIN_DB, FADER_MAX_DB)
]

export const METER_SCALE_MARKS: readonly MixerDbScaleMark[] = [
  scaleMark(0, "0", METER_MIN_DB, METER_MAX_DB, true),
  scaleMark(-6, "−6", METER_MIN_DB, METER_MAX_DB),
  scaleMark(-12, "−12", METER_MIN_DB, METER_MAX_DB),
  scaleMark(-24, "−24", METER_MIN_DB, METER_MAX_DB),
  scaleMark(-48, "−48", METER_MIN_DB, METER_MAX_DB),
  scaleMark(-60, "−∞", METER_MIN_DB, METER_MAX_DB)
]
