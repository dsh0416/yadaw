import { effectScope, nextTick, shallowRef } from "vue"
import { describe, expect, it } from "vitest"
import type { MeterPeakHold, MeterReturnRate, MixerChannelMeter } from "@yadaw/contracts"
import { usePeakMeterDisplay } from "./usePeakMeterDisplay"

function meter(peak: number, clipped = false): MixerChannelMeter {
  return {
    channelId: "audio",
    preFaderPeak: [peak, peak],
    postFaderPeak: [peak, peak],
    heldPeak: [peak, peak],
    clipped
  }
}

describe("usePeakMeterDisplay", () => {
  it("holds a transient for 800 ms and then returns at IEC Type I speed", async () => {
    let timestamp = 0
    const meterSample = shallowRef(meter(0.5))
    const peakHold = shallowRef<MeterPeakHold>("800ms")
    const returnRate = shallowRef<MeterReturnRate>("iec-type-i")
    const scope = effectScope()
    const display = scope.run(() => usePeakMeterDisplay({
      meter: meterSample,
      peakHold,
      returnRate,
      now: () => timestamp
    }))!

    expect(display.heldPeakDb.value).toBeCloseTo(-6.02, 2)

    timestamp = 700
    meterSample.value = meter(0.1)
    await nextTick()
    expect(display.heldPeakDb.value).toBeCloseTo(-6.02, 2)

    timestamp = 900
    meterSample.value = meter(0.1)
    await nextTick()
    expect(display.heldPeakDb.value).toBeCloseTo(-8.38, 2)
    expect(display.displayedPeakDb.value).toBeCloseTo(-16.64, 2)

    scope.stop()
  })

  it("clears a latched clip until the native meter reports its cleared state", async () => {
    const meterSample = shallowRef(meter(1, true))
    const scope = effectScope()
    const display = scope.run(() => usePeakMeterDisplay({
      meter: meterSample,
      peakHold: shallowRef<MeterPeakHold>("800ms"),
      returnRate: shallowRef<MeterReturnRate>("iec-type-i"),
      now: () => 0
    }))!

    expect(display.clipped.value).toBe(true)
    display.resetClip()
    expect(display.clipped.value).toBe(false)

    meterSample.value = meter(1, true)
    await nextTick()
    expect(display.clipped.value).toBe(false)
    meterSample.value = meter(0, false)
    await nextTick()
    meterSample.value = meter(1, true)
    await nextTick()
    expect(display.clipped.value).toBe(true)

    scope.stop()
  })
})
