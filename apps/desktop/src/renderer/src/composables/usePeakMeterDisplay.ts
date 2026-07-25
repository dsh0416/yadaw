import { computed, shallowRef, watch } from "vue"
import type { Ref } from "vue"
import type { MeterPeakHold, MeterReturnRate, MixerChannelMeter } from "@yadaw/contracts"

const METER_FLOOR_DB = -60

const PEAK_HOLD_DURATION_MS: Record<MeterPeakHold, number> = {
  "800ms": 800,
  "2s": 2_000,
  "4s": 4_000,
  infinite: Number.POSITIVE_INFINITY
}

const RETURN_RATE_DB_PER_SECOND: Record<MeterReturnRate, number> = {
  "iec-type-i": 11.8
}

function amplitudeToDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY
}

function decay(db: number, elapsedSeconds: number, rate: number): number {
  if (!Number.isFinite(db)) return Number.NEGATIVE_INFINITY
  const next = db - elapsedSeconds * rate
  return next <= METER_FLOOR_DB ? Number.NEGATIVE_INFINITY : next
}

function dbToLevelPercent(db: number): number {
  return Number.isFinite(db)
    ? Math.min(100, Math.max(0, (db + 60) / 60 * 100))
    : 0
}

export function usePeakMeterDisplay(options: {
  meter: Readonly<Ref<MixerChannelMeter>>
  peakHold: Readonly<Ref<MeterPeakHold>>
  returnRate: Readonly<Ref<MeterReturnRate>>
  now?: () => number
}) {
  const now = options.now ?? (() => performance.now())
  const displayedPeakDb = shallowRef(Number.NEGATIVE_INFINITY)
  const heldPeakDb = shallowRef(Number.NEGATIVE_INFINITY)
  const clipped = shallowRef(false)
  let lastUpdate = now()
  let holdUntil = 0
  let ignoreClipUntilCleared = false

  watch(
    [options.meter, options.peakHold, options.returnRate],
    ([meter, peakHold, returnRate]) => {
      const timestamp = now()
      const elapsedSeconds = Math.max(0, timestamp - lastUpdate) / 1_000
      const inputPeakDb = amplitudeToDb(Math.max(...meter.postFaderPeak))
      const rate = RETURN_RATE_DB_PER_SECOND[returnRate]
      const returnedPeak = decay(displayedPeakDb.value, elapsedSeconds, rate)

      displayedPeakDb.value = Math.max(inputPeakDb, returnedPeak)

      if (
        !Number.isFinite(heldPeakDb.value) ||
        inputPeakDb >= heldPeakDb.value
      ) {
        heldPeakDb.value = inputPeakDb
        holdUntil = Number.isFinite(PEAK_HOLD_DURATION_MS[peakHold])
          ? timestamp + PEAK_HOLD_DURATION_MS[peakHold]
          : Number.POSITIVE_INFINITY
      } else if (timestamp >= holdUntil) {
        heldPeakDb.value = Math.max(
          inputPeakDb,
          decay(heldPeakDb.value, elapsedSeconds, rate)
        )
      }

      if (!meter.clipped) {
        ignoreClipUntilCleared = false
        clipped.value = false
      } else if (!ignoreClipUntilCleared) {
        clipped.value = true
      }
      lastUpdate = timestamp
    },
    { immediate: true }
  )

  const meterLevelPercent = computed(() => dbToLevelPercent(displayedPeakDb.value))
  const heldMeterLevelPercent = computed(() => dbToLevelPercent(heldPeakDb.value))

  function resetClip(): void {
    ignoreClipUntilCleared = true
    clipped.value = false
    heldPeakDb.value = displayedPeakDb.value
    holdUntil = now() + PEAK_HOLD_DURATION_MS[options.peakHold.value]
  }

  return {
    displayedPeakDb,
    heldPeakDb,
    clipped,
    meterLevelPercent,
    heldMeterLevelPercent,
    resetClip
  }
}
