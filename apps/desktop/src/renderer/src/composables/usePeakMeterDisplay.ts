import { computed, shallowRef, watch } from "vue"
import type { Ref } from "vue"
import type { MeterPeakHold, MeterReturnRate, MixerChannelMeter } from "@yadaw/contracts"
import { dbToLevelPercent, METER_MAX_DB, METER_MIN_DB } from "../utils/mixerDbScale"

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
  return next <= METER_MIN_DB ? Number.NEGATIVE_INFINITY : next
}

export function usePeakMeterDisplay(options: {
  meter: Readonly<Ref<MixerChannelMeter>>
  peakHold: Readonly<Ref<MeterPeakHold>>
  returnRate: Readonly<Ref<MeterReturnRate>>
  now?: () => number
}) {
  const now = options.now ?? (() => performance.now())
  const currentPeakDb = computed(() =>
    amplitudeToDb(Math.max(...options.meter.value.postFaderPeak))
  )
  const heldPeakDb = shallowRef(Number.NEGATIVE_INFINITY)
  const latchedPeakDb = shallowRef(Number.NEGATIVE_INFINITY)
  const clipped = shallowRef(false)
  let lastUpdate = now()
  let holdUntil = 0
  let ignoreClipUntilCleared = false

  watch(
    [options.meter, options.peakHold, options.returnRate],
    ([meter, peakHold, returnRate]) => {
      const timestamp = now()
      const elapsedSeconds = Math.max(0, timestamp - lastUpdate) / 1_000
      const inputPeakDb = currentPeakDb.value
      const rate = RETURN_RATE_DB_PER_SECOND[returnRate]

      latchedPeakDb.value = Math.max(latchedPeakDb.value, inputPeakDb)

      if (!Number.isFinite(heldPeakDb.value) || inputPeakDb >= heldPeakDb.value) {
        heldPeakDb.value = inputPeakDb
        holdUntil = Number.isFinite(PEAK_HOLD_DURATION_MS[peakHold])
          ? timestamp + PEAK_HOLD_DURATION_MS[peakHold]
          : Number.POSITIVE_INFINITY
      } else if (timestamp >= holdUntil) {
        heldPeakDb.value = Math.max(inputPeakDb, decay(heldPeakDb.value, elapsedSeconds, rate))
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

  const meterLevelPercent = computed(() =>
    dbToLevelPercent(currentPeakDb.value, METER_MIN_DB, METER_MAX_DB)
  )
  const heldMeterLevelPercent = computed(() =>
    dbToLevelPercent(heldPeakDb.value, METER_MIN_DB, METER_MAX_DB)
  )

  function resetPeakAndClip(): void {
    ignoreClipUntilCleared = true
    clipped.value = false
    latchedPeakDb.value = Number.NEGATIVE_INFINITY
  }

  return {
    currentPeakDb,
    heldPeakDb,
    latchedPeakDb,
    clipped,
    meterLevelPercent,
    heldMeterLevelPercent,
    resetPeakAndClip
  }
}
